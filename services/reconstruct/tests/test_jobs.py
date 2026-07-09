"""The submit→poll job store (no FastAPI, just the asyncio state machine).

A submitted job runs as a background task: queued/running → completed (with its result) on success,
or → failed (capturing the error string) on exception. Unknown ids are None. Terminal jobs are
bounded (TTL + max-count eviction — same pattern as services/nerf) so the store cannot grow without
bound until restart; non-terminal jobs are bounded by the running TTL (a hung job is force-failed →
terminal → evictable). This is the contract the HTTP layer (test_api) exposes; testing it directly
keeps the state machine honest without a server.
"""

import asyncio

from app.jobs import JobState, JobStore


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
            return {"step": "ISO-10303-21..."}

        job = await store.submit(work)
        assert job.state in (JobState.queued, JobState.running)
        await _drain(store, job.id)
        done = store.get(job.id)
        assert done is not None
        assert done.state == JobState.completed
        assert done.result == {"step": "ISO-10303-21..."}
        assert done.error is None

    asyncio.run(run())


def test_job_failure_captures_the_error():
    async def run():
        store = JobStore()

        async def work() -> dict:
            raise RuntimeError("reconstruction blew up")

        job = await store.submit(work)
        await _drain(store, job.id)
        done = store.get(job.id)
        assert done is not None
        assert done.state == JobState.failed
        assert done.result is None
        assert "reconstruction blew up" in (done.error or "")

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


def test_hung_job_is_failed_after_the_running_ttl():
    async def run():
        store = JobStore(running_ttl_seconds=0.05)

        async def hang() -> dict:
            await asyncio.sleep(30)  # a hung reconstruction
            return {}

        job = await store.submit(hang)
        await asyncio.sleep(0.1)  # let the running TTL lapse
        assert store.running_count() == 0  # the sweep force-failed it → cap capacity is released
        hung = store.get(job.id)
        assert hung is not None
        assert hung.state == JobState.failed
        assert "running TTL" in (hung.error or "")
        assert hung.finished_at is not None  # terminal → evictable like any finished job

    asyncio.run(run())


def test_ttl_failed_hung_job_is_evicted():
    async def run():
        store = JobStore(running_ttl_seconds=0.05, ttl_seconds=0.0)

        async def hang() -> dict:
            await asyncio.sleep(30)
            return {}

        job = await store.submit(hang)
        await asyncio.sleep(0.1)  # the running TTL lapses
        await store.submit(lambda: _aresult({}))  # sweep pass: the hung job goes terminal
        await asyncio.sleep(0.02)  # zero terminal TTL — let the monotonic clock advance
        await store.submit(lambda: _aresult({}))  # eviction pass drops it
        assert store.get(job.id) is None  # a hung job no longer lives in the store forever

    asyncio.run(run())


def test_late_result_does_not_resurrect_a_ttl_failed_job():
    async def run():
        store = JobStore(running_ttl_seconds=0.05)

        async def stubborn() -> dict:
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                pass  # a worker that resists cancellation and still produces a result
            return {"late": True}

        job = await store.submit(stubborn)
        await asyncio.sleep(0.1)  # the running TTL lapses
        failed = store.get(job.id)  # get() runs the sweep → force-failed
        assert failed is not None
        assert failed.state == JobState.failed
        assert failed.task is not None
        await asyncio.gather(failed.task, return_exceptions=True)  # let the resisted task finish
        done = store.get(job.id)
        assert done is not None
        assert done.state == JobState.failed  # the late result was discarded, not resurrected
        assert done.result is None

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
