"""In-memory async job store.

Reconstruction is CPU-bound and can be slow, so the API is submit→poll — the same shape
the browser already speaks to the fal mesh-gen queue, so the client's ReconstructionProvider
(R6.6) reuses that polling pattern. Jobs run as background tasks on the event loop; the
heavy OCCT work itself is dispatched to a worker thread by the caller.

Bounded by construction (same pattern as services/nerf): each job result holds full STEP text,
so terminal (completed/failed) jobs are evicted by TTL and a max-count cap on every submit —
otherwise the store would grow without bound until restart. Non-terminal jobs are bounded too:
a job stuck queued/running past the running TTL is force-failed (its task cancelled) so it stops
counting against the concurrency cap and is evicted like any other terminal job. The background
task is retained on the Job so the event loop cannot GC it mid-flight.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import Enum

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
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.monotonic)  # submit time (for the running TTL)
    finished_at: float | None = None  # monotonic time the job reached a terminal state (for TTL)
    task: asyncio.Task | None = field(default=None, repr=False)  # retained so the loop can't GC it


class JobStore:
    def __init__(
        self,
        *,
        max_terminal: int = 64,
        ttl_seconds: float = 1800.0,
        running_ttl_seconds: float = 1800.0,
    ) -> None:
        self._jobs: dict[str, Job] = {}
        self._max_terminal = max_terminal
        self._ttl = ttl_seconds
        self._running_ttl = running_ttl_seconds

    async def submit(self, work: Callable[[], Awaitable[dict]]) -> Job:
        self._evict()  # bound memory before adding another (each result can hold a large STEP)
        job = Job(id=uuid.uuid4().hex)
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job, work))
        logger.info("job %s submitted", job.id)
        return job

    async def _run(self, job: Job, work: Callable[[], Awaitable[dict]]) -> None:
        job.state = JobState.running
        started = time.monotonic()
        logger.info("job %s started", job.id)
        try:
            result = await work()
            if job.state in _TERMINAL:  # force-failed by the running-TTL sweep → discard the late result
                return
            job.result = result
            job.state = JobState.completed
            logger.info("job %s completed in %.2fs", job.id, time.monotonic() - started)
        except Exception as e:  # noqa: BLE001 — any failure is surfaced to the client via /result
            if job.state in _TERMINAL:  # already force-failed by the running-TTL sweep
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
        """Force-fail non-terminal jobs older than the running TTL (a hung/stuck reconstruction).
        The in-flight worker thread cannot be force-killed, but the awaiting task is cancelled and
        the job becomes terminal — so it stops counting against the concurrency cap and is evicted
        like any other terminal job."""
        now = time.monotonic()
        for job in self._jobs.values():
            if job.state in _TERMINAL or now - job.created_at <= self._running_ttl:
                continue
            job.error = f"job exceeded the running TTL ({self._running_ttl:g}s) and was marked failed"
            job.state = JobState.failed
            job.finished_at = now
            if job.task is not None:
                job.task.cancel()
            logger.warning("job %s exceeded the running TTL (%gs); marked failed", job.id, self._running_ttl)

    def _evict(self) -> None:
        """Drop terminal jobs older than the TTL, then cap the number of retained terminal jobs."""
        self._expire_stalled()  # a stalled job must go terminal before the passes below can drop it
        now = time.monotonic()
        terminal = [(jid, j) for jid, j in self._jobs.items() if j.finished_at is not None]
        for jid, j in terminal:
            if now - (j.finished_at or now) > self._ttl:
                del self._jobs[jid]
        terminal = sorted(
            ((jid, j) for jid, j in self._jobs.items() if j.finished_at is not None),
            key=lambda kv: kv[1].finished_at or 0.0,
        )
        for jid, _ in terminal[: max(0, len(terminal) - self._max_terminal)]:  # drop oldest excess
            del self._jobs[jid]

    def running_count(self) -> int:
        """Jobs not yet in a terminal state — lets callers bound concurrent reconstruction load.
        Sweeps stalled jobs first so a hung job cannot hold the concurrency cap forever."""
        self._expire_stalled()
        return sum(1 for j in self._jobs.values() if j.state not in _TERMINAL)

    def get(self, job_id: str) -> Job | None:
        self._expire_stalled()  # a poll of a hung job reports it failed instead of running forever
        return self._jobs.get(job_id)

    def remove(self, job_id: str) -> Job | None:
        """Drop a job record. An in-flight worker thread cannot be force-killed, so its eventual
        result is simply discarded."""
        return self._jobs.pop(job_id, None)
