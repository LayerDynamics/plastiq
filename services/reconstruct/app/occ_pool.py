"""Spawn-context crash-isolated worker execution for native-code boundaries.

SPEC-12 §7: OCCT is native code — a segfault inside ``pythonocc-core`` kills the
whole interpreter and ``try/except`` cannot catch it. Running every OCCT
conversion in a separate spawn-context process turns a native crash into a
normal Python-level failure: the job fails, the service lives. ``occ_step.py``
(U6.1) is the consumer — it routes each conversion through
``run_isolated(build_step_worker, surfaces_json_dict, ...)``.

Pattern reimplemented (not copied) from StepForge ``reward/scd_reward.py``
(Apache-2.0), which isolates OCC tessellation the same way.

Why **spawn**, not fork: fork inherits the parent's native/thread state (MLX,
OpenMP, gRPC threads under FastAPI); a fresh interpreter starts clean and
cannot deadlock on inherited locks. Spawn requires the worker callable to be
pickled *by reference* (module + qualified name) and re-imported in the child,
hence the module-level-callable requirement enforced below.

Why a **fresh process per call** instead of a persistent pool (StepForge keeps
a warm ``ProcessPoolExecutor`` because it scores thousands of sub-second
completions per training run, so spawn startup would dominate): here a fitting
job runs for seconds and calls the OCCT conversion **once per job**, so the
~hundreds-of-ms spawn cost is noise. A fresh interpreter per call also
guarantees no corrupted OCCT/native state can leak from one job's crash into
the next, and removes the pool-poisoning machinery (``BrokenProcessPool``
detection + global-pool rebuild) that pool reuse requires. Self-healing is
trivial: after any crash the next call simply spawns a new worker.

Re-raise semantics: the worker's original exception type may not be importable
(or picklable) in the caller, so failures are **wrapped**, never re-raised as
the original type. Every failure surfaces as :class:`IsolatedWorkerError` in
exactly one of three flavors:

- normal worker exception  → ``abnormal=False, timed_out=False`` with the
  original type name, message, and full traceback text preserved;
- abnormal death (segfault, ``os.abort()``, kill) → ``abnormal=True`` with the
  exit code and, when killed by a signal, the signal name;
- hung worker past ``timeout`` → ``timed_out=True`` (worker terminated).

stdlib ``multiprocessing`` only — no third-party dependencies, no RNG.
"""

from __future__ import annotations

import multiprocessing
import signal
import time
import traceback
from typing import Any, Callable

__all__ = ["IsolatedWorkerError", "run_isolated"]

_POLL_INTERVAL_S = 0.05
_JOIN_GRACE_S = 5.0


class IsolatedWorkerError(RuntimeError):
    """A crash-isolated worker call failed.

    Attributes:
        abnormal: ``True`` when the worker process died without delivering a
            result or exception (native segfault, ``os.abort()``, external
            kill) — the crash-isolation case.
        timed_out: ``True`` when the worker exceeded ``timeout`` and was
            terminated by the caller.
        original_type: worker exception class name (normal-exception flavor).
        original_traceback: worker traceback text (normal-exception flavor).
        exitcode: the worker process exit code, when known (negative means
            killed by that signal number, per ``multiprocessing``).
        signal_name: e.g. ``"SIGABRT"`` when the worker died by a signal.
    """

    def __init__(
        self,
        message: str,
        *,
        abnormal: bool,
        timed_out: bool = False,
        original_type: str | None = None,
        original_traceback: str | None = None,
        exitcode: int | None = None,
        signal_name: str | None = None,
    ) -> None:
        super().__init__(message)
        self.abnormal = abnormal
        self.timed_out = timed_out
        self.original_type = original_type
        self.original_traceback = original_traceback
        self.exitcode = exitcode
        self.signal_name = signal_name


def _ensure_spawn_importable(fn: Callable[..., Any]) -> None:
    """Reject callables the spawn child cannot re-import, with a clear error."""
    if not callable(fn):
        raise TypeError(f"run_isolated expects a callable, got {type(fn).__name__}")
    module = getattr(fn, "__module__", None)
    qualname = getattr(fn, "__qualname__", None)
    if (
        module is None
        or qualname is None
        or "<lambda>" in qualname
        or "<locals>" in qualname
    ):
        raise ValueError(
            "run_isolated requires a module-level importable callable: spawn-context "
            "workers pickle the function by reference (module + qualified name) and "
            "the fresh child interpreter re-imports it, so lambdas and nested/local "
            f"functions cannot be sent to a worker (got {fn!r})"
        )


def _child_entry(conn: Any, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
    """Spawn-context child entrypoint (module-level so it pickles by reference).

    Sends exactly one payload back on ``conn``: ``("ok", result)`` or
    ``("exc", type_name, message, traceback_text)``. A native crash inside
    ``fn`` kills this process before anything is sent — the parent detects
    that as the abnormal-death flavor.
    """
    try:
        try:
            payload = ("ok", fn(*args, **kwargs))
        except BaseException as exc:
            payload = ("exc", type(exc).__name__, str(exc), traceback.format_exc())
        try:
            conn.send(payload)
        except BaseException as exc:
            # e.g. an unpicklable return value — report it instead of dying silently
            try:
                conn.send(
                    (
                        "exc",
                        type(exc).__name__,
                        f"worker completed but its result could not be sent back: {exc}",
                        traceback.format_exc(),
                    )
                )
            except BaseException:
                pass
    finally:
        conn.close()


def _terminate(proc: multiprocessing.process.BaseProcess) -> None:
    """SIGTERM the worker, escalate to SIGKILL if it lingers, and reap it."""
    if proc.is_alive():
        proc.terminate()
        proc.join(_JOIN_GRACE_S)
    if proc.is_alive():
        proc.kill()
        proc.join(_JOIN_GRACE_S)


def run_isolated(
    fn: Callable[..., Any],
    *args: Any,
    timeout: float | None = None,
    **kwargs: Any,
) -> Any:
    """Execute ``fn(*args, **kwargs)`` in a fresh spawn-context process.

    Returns the worker's (picklable) return value. ``fn`` must be a
    module-level importable callable (spawn pickles it by reference). Any
    failure — worker exception, native crash, or ``timeout`` seconds elapsed
    — raises :class:`IsolatedWorkerError`; the caller process always survives,
    and a subsequent call spawns a new worker (see module docstring for the
    flavor semantics and the per-call-process design rationale).
    """
    _ensure_spawn_importable(fn)
    fn_name = f"{fn.__module__}.{fn.__qualname__}"
    ctx = multiprocessing.get_context("spawn")
    recv_conn, send_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_child_entry, args=(send_conn, fn, args, kwargs), daemon=True
    )
    proc.start()
    send_conn.close()  # parent's copy; the child holds its own handle

    deadline = None if timeout is None else time.monotonic() + timeout
    payload: tuple | None = None
    got_payload = False
    try:
        # Drain the pipe BEFORE joining: a child blocked on send() past the OS
        # pipe buffer would deadlock against a parent blocked in join().
        while True:
            wait = _POLL_INTERVAL_S
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0.0:
                    _terminate(proc)
                    raise IsolatedWorkerError(
                        f"isolated worker {fn_name} timed out after {timeout}s "
                        "and was terminated",
                        abnormal=False,
                        timed_out=True,
                        exitcode=proc.exitcode,
                    )
                wait = min(wait, remaining)
            try:
                if recv_conn.poll(wait):
                    payload = recv_conn.recv()
                    got_payload = True
                    break
            except (EOFError, OSError):
                break  # write end closed with nothing readable → worker died
            if not proc.is_alive():
                # final drain: data may have landed between poll() and is_alive()
                try:
                    if recv_conn.poll(0):
                        payload = recv_conn.recv()
                        got_payload = True
                except (EOFError, OSError):
                    pass
                break
        proc.join(_JOIN_GRACE_S)
        if proc.is_alive():  # sent a result but refuses to exit — reap it
            _terminate(proc)
    finally:
        recv_conn.close()

    exitcode = proc.exitcode
    if got_payload and payload is not None:
        if payload[0] == "ok":
            return payload[1]
        _, orig_type, orig_msg, orig_tb = payload
        raise IsolatedWorkerError(
            f"isolated worker {fn_name} raised {orig_type}: {orig_msg}\n"
            f"--- worker traceback ---\n{orig_tb}",
            abnormal=False,
            original_type=orig_type,
            original_traceback=orig_tb,
            exitcode=exitcode,
        )

    signal_name: str | None = None
    if exitcode is not None and exitcode < 0:
        try:
            signal_name = signal.Signals(-exitcode).name
        except ValueError:
            signal_name = f"signal {-exitcode}"
    desc = f"killed by {signal_name}" if signal_name else f"exit code {exitcode}"
    raise IsolatedWorkerError(
        f"isolated worker {fn_name} died abnormally ({desc}) "
        "without returning a result",
        abnormal=True,
        exitcode=exitcode,
        signal_name=signal_name,
    )
