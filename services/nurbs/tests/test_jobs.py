"""U8.1 — the submit→poll job store (no FastAPI, just the asyncio state machine).

A submitted job runs as a background task: queued/running → completed (with its result) on success,
or → failed (capturing the error string) on exception. Unknown ids are None. DELETE semantics per
SPEC-12 §6.1: the record is dropped and an in-flight worker's eventual result is discarded — a
deleted job can never resurrect. This is the contract the HTTP layer (U8.2 test_api) exposes;
testing it directly keeps the state machine honest without a server.

Tests sequence with asyncio.Event / sleep(0) loop yields, not wall-clock races; only the TTL tests
use tiny real sleeps (<= 50ms).
"""

import asyncio

from app.jobs import JobState, JobStore


async def _drain(store: JobStore, job_id: str, tries: int = 200) -> None:
    """Yield the loop until the job goes terminal (no wall-clock dependence for immediate work)."""
    for _ in range(tries):
        job = store.get(job_id)
        if job is None or job.state in (JobState.completed, JobState.failed):
            return
        await asyncio.sleep(0)


def test_job_runs_to_completion_with_result():
    async def run():
        store = JobStore()

        async def work() -> dict:
            return {"step": "ISO-10303-21;"}

        job = await store.submit(work)
        assert job.state in (JobState.queued, JobState.running)
        assert job.task is not None  # retained so the event loop can't GC it mid-flight
        assert job.created_at > 0
        await _drain(store, job.id)
        done = store.get(job.id)
        assert done is not None
        assert done.state == JobState.completed
        assert done.result == {"step": "ISO-10303-21;"}
        assert done.error is None

    asyncio.run(run())


def test_job_failure_captures_the_error():
    async def run():
        store = JobStore()

        async def work() -> dict:
            raise RuntimeError("fit blew up")

        job = await store.submit(work)
        await _drain(store, job.id)
        done = store.get(job.id)
        assert done is not None
        assert done.state == JobState.failed
        assert done.result is None
        assert "fit blew up" in (done.error or "")

    asyncio.run(run())


def test_unknown_job_is_none():
    assert JobStore().get("does-not-exist") is None


def test_delete_drops_the_record_and_discards_the_in_flight_result():
    async def run():
        store = JobStore()
        release = asyncio.Event()

        async def work() -> dict:
            await release.wait()
            return {"step": "late result"}

        job = await store.submit(work)
        await asyncio.sleep(0)  # let the task start (queued → running)
        assert store.delete(job.id) is True
        assert store.get(job.id) is None
        assert store.delete(job.id) is False  # already gone → the API layer's 404

        # The worker "finishing" after DELETE must not resurrect the job (SPEC-12 §6.1:
        # in-flight worker's eventual result discarded).
        release.set()
        for _ in range(10):
            await asyncio.sleep(0)
        assert store.get(job.id) is None
        assert store.running_count() == 0  # a deleted job no longer holds the concurrency cap

    asyncio.run(run())


def test_running_count_reflects_in_flight_work():
    async def run():
        store = JobStore()
        release = asyncio.Event()

        async def work() -> dict:
            await release.wait()
            return {}

        job = await store.submit(work)
        assert store.running_count() == 1  # queued/running before it reaches a terminal state
        release.set()
        await _drain(store, job.id)
        assert store.running_count() == 0

    asyncio.run(run())


def test_ttl_evicts_old_terminal_jobs():
    async def run():
        store = JobStore(ttl_seconds=0.01)

        async def work() -> dict:
            return {}

        first = await store.submit(work)
        assert first.task is not None
        await first.task  # deterministic: terminal before any TTL clock matters
        assert store.get(first.id) is not None
        await asyncio.sleep(0.02)  # exceed the tiny TTL (real sleep, <= 50ms)

        second = await store.submit(work)  # submit runs the eviction pass
        assert store.get(first.id) is None  # TTL-expired terminal job evicted
        assert second.task is not None
        await second.task
        done = store.get(second.id)
        assert done is not None and done.state == JobState.completed

    asyncio.run(run())


def test_stalled_job_is_force_failed_and_its_late_result_is_discarded():
    async def run():
        store = JobStore(ttl_seconds=0.01)
        release = asyncio.Event()

        async def hung() -> dict:
            await release.wait()  # blocks past the TTL — the "stuck fit"
            return {"step": "late result"}

        job = await store.submit(hung)
        await asyncio.sleep(0)  # let the task start (queued → running)
        await asyncio.sleep(0.02)  # exceed the tiny TTL (real sleep, <= 50ms)

        # A poll sweeps stalled jobs: the hung job is force-failed with the TTL
        # message and stops counting against the concurrency cap.
        swept = store.get(job.id)
        assert swept is not None
        assert swept.state == JobState.failed
        assert "exceeded the TTL" in (swept.error or "")
        assert swept.result is None
        assert store.running_count() == 0

        # Releasing the coroutine now must NOT resurrect the job: whether the task's
        # cancellation wins or its late return hits the _run terminal-state guard,
        # the record stays failed and the late result is discarded (SPEC-12 §6.1).
        release.set()
        for _ in range(10):
            await asyncio.sleep(0)
        final = store.get(job.id)
        assert final is not None
        assert final.state == JobState.failed
        assert final.result is None
        assert store.running_count() == 0

    asyncio.run(run())


def test_max_count_evicts_the_oldest_terminal_job_first():
    async def run():
        store = JobStore(ttl_seconds=1000.0, max_jobs=2)

        async def work() -> dict:
            return {}

        jobs = []
        for _ in range(3):
            job = await store.submit(work)
            await _drain(store, job.id)
            jobs.append(job)
        # All three are terminal; one more submit runs the eviction pass.
        release = asyncio.Event()

        async def held() -> dict:
            await release.wait()
            return {}

        in_flight = await store.submit(held)
        assert store.get(jobs[0].id) is None  # oldest completed evicted first
        assert store.get(jobs[1].id) is not None
        assert store.get(jobs[2].id) is not None
        assert store.get(in_flight.id) is not None  # running job never evicted under max pressure
        release.set()
        await _drain(store, in_flight.id)

    asyncio.run(run())
