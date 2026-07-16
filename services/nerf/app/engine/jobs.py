"""In-memory async job store for the NeRF service (submit→poll).

Training a field + extracting a mesh is slow (seconds to minutes), so the API is submit→poll — the
same shape services/capture and services/reconstruct expose, so the browser reuses one polling client.
Jobs run as background tasks on the event loop; the heavy MLX training is dispatched to a worker thread
by the caller (so the loop stays responsive).

Bounded by construction: each job result holds a full base64 GLB, so terminal (completed/failed) jobs
are evicted by TTL and a max-count cap on every submit — otherwise the store would grow without bound.
The background task is retained on the Job so the event loop cannot GC it mid-flight.
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
    finished_at: float | None = None  # monotonic time the job reached a terminal state (for TTL)
    task: asyncio.Task | None = field(default=None, repr=False)  # retained so the loop can't GC it


class JobStore:
    def __init__(self, *, max_terminal: int = 64, ttl_seconds: float = 1800.0) -> None:
        self._jobs: dict[str, Job] = {}
        self._max_terminal = max_terminal
        self._ttl = ttl_seconds

    async def submit(self, work: Callable[[], Awaitable[dict]]) -> Job:
        self._evict()  # bound memory before adding another (each result can hold a large GLB)
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
            job.result = await work()
            job.state = JobState.completed
            logger.info("job %s completed in %.2fs", job.id, time.monotonic() - started)
        except Exception as e:  # noqa: BLE001 — any failure is surfaced to the client via /result
            job.error = str(e)
            job.state = JobState.failed
            logger.error(
                "job %s failed after %.2fs: %s", job.id, time.monotonic() - started, e, exc_info=True
            )
        finally:
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
        for jid, _ in terminal[: max(0, len(terminal) - self._max_terminal)]:  # drop oldest excess
            del self._jobs[jid]

    def running_count(self) -> int:
        """Jobs not yet in a terminal state — used to cap concurrent training load."""
        return sum(1 for j in self._jobs.values() if j.state not in _TERMINAL)

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def remove(self, job_id: str) -> Job | None:
        """Drop a job record (used by DELETE /jobs/{id}). An in-flight worker thread cannot be
        force-killed, so its eventual result is simply discarded."""
        return self._jobs.pop(job_id, None)
