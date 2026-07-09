"""In-memory async job store for the NURBS fitting service (submit→poll).

Fitting is compute-bound and slow (seconds), so the API is submit→poll — the same shape
services/reconstruct, services/capture and services/nerf expose, so the browser reuses one polling
client (SPEC-12 §6.1). Jobs run as background tasks on the event loop; the heavy MLX/OCCT work is
dispatched off the loop by the caller (``asyncio.to_thread`` in main.py).

Bounded by construction (the reconstruct/nerf ``app/jobs.py`` shape): each job result holds full
STEP text, so terminal (completed/failed) jobs are evicted by TTL and a max-count cap on every
submit — otherwise the store would grow without bound until restart. Where the two siblings
disagree, this file follows reconstruct: non-terminal jobs stuck past the TTL are force-failed
(their task cancelled) so a hung fit cannot hold the concurrency cap forever — nerf has no such
sweep. Unlike reconstruct's two knobs (``ttl_seconds`` + ``running_ttl_seconds``, both 1800 s by
default), a single ``ttl_seconds`` bounds both terminal retention and running age. ``max_jobs``
plays the role of the siblings' ``max_terminal``: it caps *retained terminal* jobs — running jobs
are never evicted under max-count pressure, only via the TTL sweep. The background task is retained
on the Job so the event loop cannot GC it mid-flight.

DELETE semantics (SPEC-12 §6.1: "job dropped; in-flight worker's result discarded"): ``delete()``
drops the record AND cancels the in-flight task, so the worker's eventual result is discarded and a
deleted job can never resurrect. (The siblings' ``remove()`` only pops the record; cancelling too is
a strict strengthening of the same contract.)

Job ids are uuid4 hex — the sibling convention. This does not violate SPEC-12 D-10 ("no RNG
anywhere"): D-10 targets determinism of the fitting math in ``app/core`` (NFR-1 — same input →
same surfaces); job-id uniqueness is transport bookkeeping, not geometry.
"""

from __future__ import annotations

import asyncio
import logging
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


@dataclass
class Job:
    id: str
    state: JobState = JobState.queued
    created_at: float = field(default_factory=time.monotonic)  # submit time (for the running TTL)
    result: Any | None = None
    error: str | None = None
    finished_at: float | None = None  # monotonic time the job went terminal (for the terminal TTL)
    task: asyncio.Task | None = field(default=None, repr=False)  # retained so the loop can't GC it


class JobStore:
    def __init__(self, *, ttl_seconds: float = 1800.0, max_jobs: int = 64) -> None:
        self._jobs: dict[str, Job] = {}
        self._ttl = ttl_seconds
        self._max_jobs = max_jobs

    async def submit(self, coro_factory: Callable[[], Awaitable[Any]]) -> Job:
        self._evict()  # bound memory before adding another (each result can hold a large STEP)
        job = Job(id=uuid.uuid4().hex)
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job, coro_factory))
        logger.info("job %s submitted", job.id)
        return job

    async def _run(self, job: Job, coro_factory: Callable[[], Awaitable[Any]]) -> None:
        job.state = JobState.running
        started = time.monotonic()
        logger.info("job %s started", job.id)
        try:
            result = await coro_factory()
            if job.state in _TERMINAL:  # force-failed by the TTL sweep → discard the late result
                return
            job.result = result
            job.state = JobState.completed
            logger.info("job %s completed in %.2fs", job.id, time.monotonic() - started)
        except Exception as e:  # noqa: BLE001 — any failure is surfaced to the client via /result
            if job.state in _TERMINAL:  # already force-failed by the TTL sweep
                return
            job.error = str(e)
            job.state = JobState.failed
            logger.error(
                "job %s failed after %.2fs: %s", job.id, time.monotonic() - started, e, exc_info=True
            )
        finally:
            if job.finished_at is None:
                job.finished_at = time.monotonic()

    def _expire_stalled(self) -> None:
        """Force-fail non-terminal jobs older than the TTL (a hung/stuck fit). The in-flight worker
        thread cannot be force-killed, but the awaiting task is cancelled and the job goes terminal —
        so it stops counting against the concurrency cap and is evicted like any other terminal job."""
        now = time.monotonic()
        for job in self._jobs.values():
            if job.state in _TERMINAL or now - job.created_at <= self._ttl:
                continue
            job.error = f"job exceeded the TTL ({self._ttl:g}s) and was marked failed"
            job.state = JobState.failed
            job.finished_at = now
            if job.task is not None:
                job.task.cancel()
            logger.warning("job %s exceeded the TTL (%gs); marked failed", job.id, self._ttl)

    def _evict(self) -> None:
        """Drop terminal jobs older than the TTL, then cap the number of retained terminal jobs
        (oldest-finished first). Running jobs are untouched by the max-count pass."""
        self._expire_stalled()  # a stalled job must go terminal before the passes below can drop it
        now = time.monotonic()
        for jid, job in list(self._jobs.items()):
            if job.finished_at is not None and now - job.finished_at > self._ttl:
                del self._jobs[jid]
        terminal = sorted(
            ((jid, j) for jid, j in self._jobs.items() if j.finished_at is not None),
            key=lambda kv: kv[1].finished_at or 0.0,
        )
        for jid, _ in terminal[: max(0, len(terminal) - self._max_jobs)]:  # drop oldest excess
            del self._jobs[jid]

    def running_count(self) -> int:
        """Jobs not yet in a terminal state — lets main.py bound concurrent fitting load.
        Sweeps stalled jobs first so a hung job cannot hold the concurrency cap forever."""
        self._expire_stalled()
        return sum(1 for j in self._jobs.values() if j.state not in _TERMINAL)

    def get(self, job_id: str) -> Job | None:
        self._expire_stalled()  # a poll of a hung job reports it failed instead of running forever
        return self._jobs.get(job_id)

    def delete(self, job_id: str) -> bool:
        """Drop a job record (DELETE /jobs/{id}); True iff it existed (the API layer's 204 vs 404).
        The in-flight task is cancelled so the worker's eventual result is discarded (§6.1) — and
        with the record popped, a write that already raced past the cancel cannot resurrect it."""
        job = self._jobs.pop(job_id, None)
        if job is None:
            return False
        if job.task is not None and not job.task.done():
            job.task.cancel()
        logger.info("job %s deleted", job_id)
        return True
