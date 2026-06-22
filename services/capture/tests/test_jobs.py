"""M7 — the submit→poll job contract (no FastAPI needed, so it runs anywhere). Proves the JobStore
state machine: queued → running → completed, and failures surface as `failed` + an error."""

import asyncio

from app.jobs import JobState, JobStore


async def _drive(work) -> object:
    store = JobStore()
    job = await store.submit(work)
    for _ in range(500):
        j = store.get(job.id)
        if j and j.state in (JobState.completed, JobState.failed):
            return j
        await asyncio.sleep(0.001)
    return store.get(job.id)


def test_submit_poll_completes_with_result():
    async def work() -> dict:
        return {"faces": 42}

    job = asyncio.run(_drive(work))
    assert job.state == JobState.completed
    assert job.result == {"faces": 42}


def test_failed_work_is_surfaced():
    async def work() -> dict:
        raise ValueError("fit diverged")

    job = asyncio.run(_drive(work))
    assert job.state == JobState.failed
    assert "fit diverged" in (job.error or "")
