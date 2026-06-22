"""N10.1 — the submit→poll job store (no FastAPI, just the asyncio state machine).

A submitted job runs as a background task: queued/running → completed (with its result) on success, or
→ failed (capturing the error string) on exception. Unknown ids are None. This is the contract the
HTTP layer (test_api) exposes; testing it directly keeps the state machine honest without a server.
"""

import asyncio

from app.engine.jobs import JobState, JobStore


async def _drain(store: JobStore, job_id: str, tries: int = 200) -> None:
    for _ in range(tries):
        job = store.get(job_id)
        if job and job.state in (JobState.completed, JobState.failed):
            return
        await asyncio.sleep(0.01)


def test_job_runs_to_completion_with_result():
    async def run():
        store = JobStore()

        async def work() -> dict:
            return {"value": 42}

        job = await store.submit(work)
        assert job.state in (JobState.queued, JobState.running)
        await _drain(store, job.id)
        done = store.get(job.id)
        assert done is not None
        assert done.state == JobState.completed
        assert done.result == {"value": 42}
        assert done.error is None

    asyncio.run(run())


def test_job_failure_captures_the_error():
    async def run():
        store = JobStore()

        async def work() -> dict:
            raise RuntimeError("training blew up")

        job = await store.submit(work)
        await _drain(store, job.id)
        done = store.get(job.id)
        assert done is not None
        assert done.state == JobState.failed
        assert done.result is None
        assert "training blew up" in (done.error or "")

    asyncio.run(run())


def test_unknown_job_is_none():
    assert JobStore().get("does-not-exist") is None
