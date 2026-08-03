"""In-memory async job store for the capture service (submit→poll).

Surface reconstruction (MLX SDF fit + marching cubes) is slow, so the API is submit→poll — the same
shape the browser already speaks to the reconstruct service and the fal mesh-gen queue. Jobs run as
background tasks on the event loop; heavy MLX work is run in a **spawned child process** so DELETE
cancel can force-stop the worker (terminate/kill), not only drop the job record (P0.2).

Bounded by construction (same pattern as services/nerf): each job result holds a full base64 GLB, so
terminal (completed/failed) jobs are evicted by TTL and a max-count cap on every submit — otherwise
the store would grow without bound until restart. The background task is retained on the Job so the
event loop cannot GC it mid-flight.
"""

from __future__ import annotations

import asyncio
import logging
import multiprocessing
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class JobState(str, Enum):
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"


_TERMINAL = (JobState.completed, JobState.failed)
_JOIN_GRACE_S = 2.0


def _process_entry(
    q: "multiprocessing.Queue", target: Callable[..., dict], args: tuple, kwargs: dict
) -> None:
    """Spawn-child entry point (module-level so it is picklable under the spawn context).

    Runs ``target(*args, **kwargs)`` and puts ``("ok", result)`` or ``("err", message)``
    on the queue so the parent can publish the result or surface the failure.
    """
    try:
        q.put(("ok", target(*args, **kwargs)))
    except Exception as e:  # noqa: BLE001 — surface any worker failure to the parent
        q.put(("err", f"{type(e).__name__}: {e}"))


@dataclass
class Job:
    id: str
    state: JobState = JobState.queued
    result: dict | None = None
    error: str | None = None
    finished_at: float | None = None  # monotonic time the job reached a terminal state (for TTL)
    task: asyncio.Task | None = field(default=None, repr=False)
    process: Any = field(default=None, repr=False)  # multiprocessing.Process when work is isolated
    cancelled: bool = False


class JobStore:
    def __init__(self, *, max_terminal: int = 64, ttl_seconds: float = 1800.0) -> None:
        self._jobs: dict[str, Job] = {}
        self._max_terminal = max_terminal
        self._ttl = ttl_seconds

    async def submit(self, work: Callable[[], Awaitable[dict]]) -> Job:
        self._evict()
        job = Job(id=uuid.uuid4().hex)
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job, work))
        logger.info("job %s submitted", job.id)
        return job

    async def submit_process(
        self,
        target: Callable[..., dict],
        args: tuple = (),
        kwargs: dict | None = None,
    ) -> Job:
        """Submit work that runs in a spawn-context child process (force-killable on cancel).

        ``target`` must be a top-level picklable callable that returns a result dict.
        """
        self._evict()
        job = Job(id=uuid.uuid4().hex)
        self._jobs[job.id] = job
        kw = dict(kwargs or {})

        async def work() -> dict:
            return await self._run_process(job, target, args, kw)

        job.task = asyncio.create_task(self._run(job, work))
        logger.info("job %s submitted (process-isolated)", job.id)
        return job

    async def _run_process(
        self,
        job: Job,
        target: Callable[..., dict],
        args: tuple,
        kwargs: dict,
    ) -> dict:
        ctx = multiprocessing.get_context("spawn")
        queue: multiprocessing.Queue = ctx.Queue()

        # The worker entry must be a MODULE-LEVEL callable (`_process_entry`), not a local
        # closure: under the spawn context (the default on macOS — the M4 Max target) the
        # Process target is pickled, and a nested closure is unpicklable
        # ("Can't pickle local object …"), which would fail EVERY process-isolated job.
        proc = ctx.Process(target=_process_entry, args=(queue, target, args, kwargs), daemon=True)
        job.process = proc
        proc.start()
        try:
            while proc.is_alive():
                if job.cancelled:
                    raise asyncio.CancelledError()
                await asyncio.sleep(0.05)
            # Drain result
            if job.cancelled:
                raise asyncio.CancelledError()
            if not queue.empty():
                kind, payload = queue.get_nowait()
                if kind == "ok":
                    return payload
                raise RuntimeError(str(payload))
            if proc.exitcode not in (0, None):
                raise RuntimeError(f"worker process exited with code {proc.exitcode}")
            raise RuntimeError("worker process finished without a result")
        finally:
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=_JOIN_GRACE_S)
                if proc.is_alive():
                    proc.kill()
                    proc.join(timeout=1.0)
            job.process = None

    async def _run(self, job: Job, work: Callable[[], Awaitable[dict]]) -> None:
        job.state = JobState.running
        started = time.monotonic()
        logger.info("job %s started", job.id)
        try:
            result = await work()
            if job.cancelled or job.state in _TERMINAL:
                return  # cancel won the race — never publish a late result
            job.result = result
            job.state = JobState.completed
            logger.info("job %s completed in %.2fs", job.id, time.monotonic() - started)
        except asyncio.CancelledError:
            if not job.cancelled:
                job.cancelled = True
            job.error = "cancelled"
            job.state = JobState.failed
            logger.info("job %s cancelled after %.2fs", job.id, time.monotonic() - started)
        except Exception as e:  # noqa: BLE001 — any failure is surfaced to the client via /result
            if job.cancelled or job.state in _TERMINAL:
                return
            job.error = str(e)
            job.state = JobState.failed
            logger.error(
                "job %s failed after %.2fs: %s", job.id, time.monotonic() - started, e, exc_info=True
            )
        finally:
            if job.finished_at is None:
                job.finished_at = time.monotonic()

    def _evict(self) -> None:
        """Drop terminal jobs older than the TTL, then cap the number of retained terminal jobs."""
        now = time.monotonic()
        terminal = [(jid, j) for jid, j in self._jobs.items() if j.finished_at is not None]
        for jid, j in terminal:
            if now - (j.finished_at or now) > self._ttl:
                del self._jobs[jid]
        terminal = sorted(
            ((jid, j) for jid, j in self._jobs.items() if j.finished_at is not None),
            key=lambda kv: kv[1].finished_at or 0.0,
        )
        for jid, _ in terminal[: max(0, len(terminal) - self._max_terminal)]:
            del self._jobs[jid]

    def running_count(self) -> int:
        """Jobs not yet in a terminal state — lets callers bound concurrent fitting load."""
        return sum(1 for j in self._jobs.values() if j.state not in _TERMINAL)

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        """Force-stop a job: mark cancelled, cancel the asyncio task, terminate the worker process.

        The job remains in the store as ``failed`` with ``error="cancelled"`` so status/result can
        report cancellation. Late results from a killed worker are discarded in ``_run``.
        """
        job = self._jobs.get(job_id)
        if job is None:
            return None
        if job.state in _TERMINAL and not job.cancelled:
            # Already finished — still drop record for cleanup (client DELETE after done).
            return self.remove(job_id)
        job.cancelled = True
        job.error = "cancelled"
        job.state = JobState.failed
        job.finished_at = time.monotonic()
        if job.task is not None and not job.task.done():
            job.task.cancel()
        proc = job.process
        if proc is not None and getattr(proc, "is_alive", lambda: False)():
            logger.info("job %s terminating worker process pid=%s", job.id, getattr(proc, "pid", "?"))
            try:
                proc.terminate()
                proc.join(timeout=_JOIN_GRACE_S)
                if proc.is_alive():
                    proc.kill()
                    proc.join(timeout=1.0)
            except Exception as e:  # noqa: BLE001 — best-effort kill
                logger.warning("job %s process kill failed: %s", job.id, e)
            job.process = None
        logger.info("job %s cancelled", job.id)
        return job

    def remove(self, job_id: str) -> Job | None:
        """Drop a job record. Prefer :meth:`cancel` for in-flight jobs so the worker is force-stopped."""
        job = self._jobs.pop(job_id, None)
        if job is None:
            return None
        if job.state not in _TERMINAL:
            job.cancelled = True
            if job.task is not None and not job.task.done():
                job.task.cancel()
            proc = job.process
            if proc is not None and getattr(proc, "is_alive", lambda: False)():
                try:
                    proc.terminate()
                    proc.join(timeout=_JOIN_GRACE_S)
                    if proc.is_alive():
                        proc.kill()
                        proc.join(timeout=1.0)
                except Exception:  # noqa: BLE001
                    pass
        return job
