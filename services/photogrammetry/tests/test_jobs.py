"""P10.1 — the submit→poll job store for the photogrammetry service (no FastAPI, just the asyncio
state machine). Proves the JobStore contract SPEC-13 §6.1 freezes: queued → running → completed
(with its result) on success, or → failed (capturing the error string) on exception; unknown ids are
None (the HTTP layer's 404); DELETE drops the record and the in-flight worker's eventual result is
discarded (a deleted job can never resurrect); terminal jobs are bounded by a TTL + a max-count cap
(capture/nurbs `app/jobs.py` shape); the background task is retained so the loop can't GC it; and
`running_count()` exposes the in-flight load main.py caps at PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS.

MLX-free by construction — this file is one of the two the CI photogrammetry row runs without MLX
(NFR-4), so it imports only `app.jobs` (pure stdlib) and never reaches `app.pipeline` / mlx / cv2 /
numpy.

Immediate work is driven by loop-yield polling (no wall-clock dependence); only the TTL tests use
tiny real sleeps (<= 50ms).
"""

import asyncio

from app.jobs import JobState, JobStore


async def _drive(work) -> object:
    """Submit `work`, then poll until it goes terminal — returns the terminal Job."""
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
        return {"transforms_json": "{}", "sparse_ply_base64": "cGx5"}

    job = asyncio.run(_drive(work))
    assert job.state == JobState.completed
    assert job.result == {"transforms_json": "{}", "sparse_ply_base64": "cGx5"}
    assert job.error is None


def test_failed_work_is_surfaced():
    async def work() -> dict:
        raise ValueError("init pair degenerate")

    job = asyncio.run(_drive(work))
    assert job.state == JobState.failed
    assert job.result is None
    assert "init pair degenerate" in (job.error or "")


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


def test_delete_drops_record_and_discards_in_flight_result():
    async def run():
        store = JobStore()
        release = asyncio.Event()

        async def work() -> dict:
            await release.wait()  # blocks so we can delete while it is still in-flight
            return {"transforms_json": "late — must be discarded"}

        job = await store.submit(work)
        await asyncio.sleep(0)  # let the task start (queued → running)
        assert store.remove(job.id) is not None  # existed → the API layer's 204
        assert store.get(job.id) is None
        assert store.remove(job.id) is None  # already gone → the API layer's 404

        # The worker "finishing" after DELETE must not resurrect the job (SPEC-13 §6.1:
        # in-flight worker's eventual result is discarded).
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
        # One more submit runs a final eviction pass.
        await store.submit(lambda: _aresult({}))
        assert store.get(first_id) is None  # oldest terminal job evicted (no unbounded growth)
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


async def _drain(store: JobStore, job_id: str, tries: int = 200) -> None:
    for _ in range(tries):
        job = store.get(job_id)
        if job and job.state in (JobState.completed, JobState.failed):
            return
        await asyncio.sleep(0.01)


async def _aresult(value: dict) -> dict:
    return value
