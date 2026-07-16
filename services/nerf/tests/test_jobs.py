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


def test_background_task_is_retained():
    async def run():
        store = JobStore()

        async def work() -> dict:
            return {}

        job = await store.submit(work)
        assert job.task is not None  # retained so the event loop can't GC it mid-flight
        await _drain(store, job.id)

    asyncio.run(run())


def test_terminal_jobs_are_evicted_when_over_cap():
    async def run():
        store = JobStore(max_terminal=2, ttl_seconds=1000.0)
        first_id = None
        for _ in range(5):

            async def work() -> dict:
                return {}

            job = await store.submit(work)
            first_id = first_id or job.id
            await _drain(store, job.id)
        # one more submit runs a final eviction pass
        await store.submit(lambda: _aresult({}))
        assert store.get(first_id) is None  # the oldest terminal job was evicted (no unbounded growth)
        assert len(store._jobs) <= 3  # ~max_terminal terminal + the in-flight one

    asyncio.run(run())


def test_remove_and_running_count():
    async def run():
        store = JobStore()

        async def work() -> dict:
            await asyncio.sleep(0.05)
            return {}

        job = await store.submit(work)
        assert store.running_count() >= 1  # queued/running before it reaches a terminal state
        assert store.remove(job.id) is not None
        assert store.get(job.id) is None
        assert store.remove(job.id) is None  # idempotent

    asyncio.run(run())


async def _aresult(value: dict) -> dict:
    return value
