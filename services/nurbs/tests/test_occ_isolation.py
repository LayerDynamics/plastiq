"""U6.2 — crash isolation for native-code (OCCT) worker calls.

Every test exercises REAL subprocess behavior through ``app.occ_pool.run_isolated``
— no mocks. Worker functions live at module level so they pickle by reference
under the spawn context: pytest imports this file as ``tests.test_occ_isolation``
(``tests/__init__.py`` exists, prepend import mode puts ``services/nurbs`` on
``sys.path``) and the spawned child re-imports it by that same name.
"""

from __future__ import annotations

import os
import time

import pytest

from app.occ_pool import IsolatedWorkerError, run_isolated


# ── module-level workers (spawn-picklable by reference) ──────────────────────


def echo_worker(a: int, b: int, *, scale: int = 1) -> dict:
    """Return a genuinely computed value so the round-trip is provably real."""
    total = (a + b) * scale
    return {"total": total, "digits": [int(c) for c in str(total)]}


def raising_worker(msg: str) -> None:
    """A worker that fails with a normal Python exception."""
    raise ValueError(msg)


def abort_worker() -> None:
    """Hard native-style crash: SIGABRT, uncatchable by in-process try/except."""
    os.abort()


def sleeping_worker(seconds: float) -> str:
    """A hung worker for the timeout path."""
    time.sleep(seconds)
    return "woke"


# ── tests ─────────────────────────────────────────────────────────────────────


def test_echo_worker_returns_computed_result():
    result = run_isolated(echo_worker, 19, 23, scale=2)
    assert result == {"total": 84, "digits": [8, 4]}


def test_worker_exception_reraised_with_original_type_message_traceback():
    with pytest.raises(IsolatedWorkerError) as excinfo:
        run_isolated(raising_worker, "bad control net")
    err = excinfo.value
    assert err.abnormal is False
    assert err.timed_out is False
    assert err.original_type == "ValueError"
    assert "ValueError" in str(err)
    assert "bad control net" in str(err)
    assert "raising_worker" in (err.original_traceback or "")
    assert "bad control net" in (err.original_traceback or "")
    # the caller process is alive and keeps computing
    assert sum(range(5)) == 10


def test_abort_is_abnormal_names_signal_and_caller_recovers():
    with pytest.raises(IsolatedWorkerError) as excinfo:
        run_isolated(abort_worker)
    err = excinfo.value
    assert err.abnormal is True
    assert err.signal_name == "SIGABRT"
    assert "SIGABRT" in str(err)
    # the caller survived the native crash; a follow-up isolated call succeeds
    result = run_isolated(echo_worker, 1, 2)
    assert result["total"] == 3


def test_hung_worker_times_out_fast():
    start = time.monotonic()
    with pytest.raises(IsolatedWorkerError) as excinfo:
        run_isolated(sleeping_worker, 30.0, timeout=1.0)
    elapsed = time.monotonic() - start
    err = excinfo.value
    assert err.timed_out is True
    assert "timed out" in str(err)
    assert elapsed < 10.0


def test_lambda_rejected_with_clear_pickling_error():
    with pytest.raises(ValueError, match="module-level"):
        run_isolated(lambda: 42)
