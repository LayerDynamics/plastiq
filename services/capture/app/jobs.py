"""In-memory async job store for the capture service (submit→poll).

Surface reconstruction (MLX SDF fit + marching cubes) is slow, so the API is submit→poll — the same
shape the browser already speaks to the reconstruct service and the fal mesh-gen queue. Jobs run as
background tasks on the event loop; the heavy MLX work is dispatched to a worker thread by the caller.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum


class JobState(str, Enum):
    queued = "queued"
    running = "running"
    completed = "completed"
    failed = "failed"


@dataclass
class Job:
    id: str
    state: JobState = JobState.queued
    result: dict | None = None
    error: str | None = None


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    async def submit(self, work: Callable[[], Awaitable[dict]]) -> Job:
        job = Job(id=uuid.uuid4().hex)
        self._jobs[job.id] = job
        asyncio.create_task(self._run(job, work))
        return job

    async def _run(self, job: Job, work: Callable[[], Awaitable[dict]]) -> None:
        job.state = JobState.running
        try:
            job.result = await work()
            job.state = JobState.completed
        except Exception as e:  # noqa: BLE001 — any failure is surfaced to the client
            job.error = str(e)
            job.state = JobState.failed

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)
