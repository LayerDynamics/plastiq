"""M7 — the submit→poll job contract (no FastAPI needed, so it runs anywhere). Proves the JobStore
state machine: queued → running → completed, and failures surface as `failed` + an error; terminal
jobs are bounded (TTL + max-count eviction — same pattern as services/nerf), the background task is
retained, and `remove`/`running_count` behave."""

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


def test_terminal_jobs_are_evicted_after_the_ttl():
    async def run():
        store = JobStore(max_terminal=64, ttl_seconds=0.0)  # everything terminal is instantly stale

        async def work() -> dict:
            return {}

        job = await store.submit(work)
        await _drain(store, job.id)
        await asyncio.sleep(0.02)  # let the monotonic clock advance past the zero TTL
        await store.submit(lambda: _aresult({}))  # the next submit runs the eviction pass
        assert store.get(job.id) is None  # TTL-evicted even though the count cap was never hit

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


async def _drain(store: JobStore, job_id: str, tries: int = 200) -> None:
    for _ in range(tries):
        job = store.get(job_id)
        if job and job.state in (JobState.completed, JobState.failed):
            return
        await asyncio.sleep(0.01)


async def _aresult(value: dict) -> dict:
    return value
