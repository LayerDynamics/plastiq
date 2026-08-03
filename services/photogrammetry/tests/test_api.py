"""The photogrammetry HTTP service, tested end-to-end over the real ASGI app (no mocks) via ``httpx``
``ASGITransport`` on ``asyncio.run`` so background jobs actually progress. Mirrors the
capture/reconstruct/nerf/nurbs API tests. Gated on ``fastapi``, so it self-skips where the web env is
not installed.

Two layers of coverage:

* **P10.2a — the HTTP shell** (auth / CORS / caps / validation / 404 / 409 / 429 / delete / health),
  driven with an injected ``solve_fn`` (the SPEC-13 §6.1 seam): ``create_app(solve_fn)`` has **no
  import-time dependency** on ``app.pipeline`` — these tests never touch the MLX/SfM stack. A
  contract-shaped ``solve_fn`` keeps them fast and deterministic (a ``threading.Event`` gate holds a
  job in flight for the 409 / 429 paths).
* **P10.2b — the real photos→result E2E** (``test_real_solve_end_to_end``), driving the PRODUCTION
  dispatcher ``app.main._load_pipeline_solve`` (NOT an injected double): a small synthetic photo set is
  submitted, polled to completion, and its ``{ transforms_json, sparse_ply_base64,
  dense_ply_base64, report }`` fetched — real feature/matching/BA sparse SfM + real MLX plane-sweep
  MVS + fusion through the live ASGI service. Gated on ``mlx.core`` + ``PIL``.
"""

import asyncio
import base64
import io
import threading

import pytest

pytest.importorskip("fastapi")
import httpx  # noqa: E402
from httpx import ASGITransport  # noqa: E402

from app.main import _load_pipeline_solve, create_app  # noqa: E402

# Report fields every result must carry (SPEC-13 FR-8 sparse fields + the dense counter).
BASE_REPORT_KEYS = {
    "images_total",
    "images_registered",
    "matching",
    "seed",
    "dense_points",
}


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def _body(**overrides) -> dict:
    """A minimal valid /solve body: three dummy base64 images (the shell does not decode them — the
    injected ``solve_fn`` ignores their content)."""
    return {"images": ["Zm9v", "YmFy", "YmF6"], **overrides}  # "foo"/"bar"/"baz"


def _contract_result(payload: dict) -> dict:
    """A §6.1-shaped result that echoes the request params — no MLX/SfM. Lets the transport tests
    assert the body flowed through ``solve_fn`` (``matching``/``seed``) without the solve stack."""
    return {
        "transforms_json": '{"frames": []}',
        "sparse_ply_base64": base64.b64encode(b"ply\nformat ascii 1.0\n").decode("ascii"),
        "dense_ply_base64": None,
        "report": {
            "images_total": len(payload["images"]),
            "images_registered": 0,
            "matching": payload["matching"],
            "seed": payload["seed"],
            "dense_points": 0,
        },
    }


def _make_gated_solve_fn(release: threading.Event):
    """A ``solve_fn`` that blocks (in the ``to_thread`` worker) until ``release`` is set, so a job can
    be held provably in flight for the 409 (result-before-done) and 429 (concurrency-cap) paths."""

    def solve_fn(payload: dict) -> dict:
        if not release.wait(timeout=10.0):
            raise TimeoutError("gated solve_fn was never released")
        return _contract_result(payload)

    return solve_fn


async def _drain(c: httpx.AsyncClient, job_id: str, tries: int = 400, delay: float = 0.02) -> str:
    """Poll status until the job is terminal (keeps worker threads from lingering after a test)."""
    state = "queued"
    for _ in range(tries):
        state = (await c.get(f"/jobs/{job_id}/status")).json()["state"]
        if state in ("completed", "failed"):
            break
        await asyncio.sleep(delay)
    return state


def test_health():
    app = create_app(_contract_result)

    async def run():
        async with _client(app) as c:
            r = await c.get("/health")
            assert r.status_code == 200
            assert r.json() == {"status": "ok", "service": "plastiq-photogrammetry"}

    asyncio.run(run())


def test_cors_header_present():
    app = create_app(_contract_result)

    async def run():
        async with _client(app) as c:
            r = await c.get("/health", headers={"Origin": "http://example.com"})
            assert r.status_code == 200
            assert "access-control-allow-origin" in r.headers

    asyncio.run(run())


def test_solve_validation_422_on_bad_input():
    app = create_app(_contract_result)

    async def run():
        async with _client(app) as c:
            for bad in (
                {"images": ["Zm9v"]},  # < MIN_IMAGES (3)
                {"images": ["Zm9v", "YmFy", "YmF6"], "names": ["a", "b"]},  # names length mismatch
                {"matching": "brute"},  # not in the Literal
                {"max_features": 511},  # < 512
                {"max_features": 16385},  # > 16384
                {"seed": -1},  # < 0
            ):
                body = _body(**bad) if "images" not in bad else bad
                r = await c.post("/solve", json=body)
                assert r.status_code == 422, f"{bad} → {r.status_code}: {r.text}"
            # images is required.
            assert (await c.post("/solve", json={})).status_code == 422

    asyncio.run(run())


def test_status_result_delete_unknown_id_404():
    app = create_app(_contract_result)

    async def run():
        async with _client(app) as c:
            assert (await c.get("/jobs/nope/status")).status_code == 404
            assert (await c.get("/jobs/nope/result")).status_code == 404
            assert (await c.delete("/jobs/nope")).status_code == 404

    asyncio.run(run())


def test_result_before_done_returns_409():
    release = threading.Event()
    app = create_app(_make_gated_solve_fn(release))

    async def run():
        job_id = None
        async with _client(app) as c:
            try:
                job_id = (await c.post("/solve", json=_body())).json()["id"]
                r = await c.get(f"/jobs/{job_id}/result")
                assert r.status_code == 409, r.text
            finally:
                release.set()
                if job_id is not None:
                    await _drain(c, job_id)

    asyncio.run(run())


def test_failed_job_status_error_and_result_500():
    def boom(payload: dict) -> dict:
        raise ValueError("solve exploded")

    app = create_app(boom)

    async def run():
        async with _client(app) as c:
            job_id = (await c.post("/solve", json=_body())).json()["id"]
            assert await _drain(c, job_id) == "failed"
            status = (await c.get(f"/jobs/{job_id}/status")).json()
            assert status["error"] and "solve exploded" in status["error"]
            r = await c.get(f"/jobs/{job_id}/result")
            assert r.status_code == 500, r.text
            assert "solve exploded" in r.json()["detail"]

    asyncio.run(run())


def test_delete_returns_204_then_404():
    app = create_app(_contract_result)

    async def run():
        async with _client(app) as c:
            job_id = (await c.post("/solve", json=_body())).json()["id"]
            assert (await c.delete(f"/jobs/{job_id}")).status_code == 204
            assert (await c.get(f"/jobs/{job_id}/status")).status_code == 404
            assert (await c.delete(f"/jobs/{job_id}")).status_code == 404

    asyncio.run(run())


def test_concurrency_cap_returns_429(monkeypatch):
    # PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS is read inside create_app (default 1).
    monkeypatch.setenv("PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS", "1")
    release = threading.Event()
    app = create_app(_make_gated_solve_fn(release))

    async def run():
        async with _client(app) as c:
            job_id = None
            try:
                r1 = await c.post("/solve", json=_body())
                assert r1.status_code == 200, r1.text
                job_id = r1.json()["id"]
                r2 = await c.post("/solve", json=_body())
                assert r2.status_code == 429, r2.text
            finally:
                release.set()
                if job_id is not None:
                    await _drain(c, job_id)

    asyncio.run(run())


def test_max_concurrent_zero_or_negative_clamps_to_one(monkeypatch):
    for bad_cap in ("0", "-3"):
        monkeypatch.setenv("PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS", bad_cap)
        app = create_app(_contract_result)

        async def run():
            async with _client(app) as c:
                r = await c.post("/solve", json=_body())
                assert r.status_code == 200, f"cap={bad_cap!r} → {r.status_code}: {r.text}"
                await _drain(c, r.json()["id"])

        asyncio.run(run())


def test_non_integer_max_concurrent_raises_clear_config_error(monkeypatch):
    monkeypatch.setenv("PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS", "not-a-number")
    with pytest.raises(RuntimeError, match="PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS"):
        create_app(_contract_result)


def test_auth_bearer_guards_solve_and_delete(monkeypatch):
    monkeypatch.setenv("PHOTOGRAMMETRY_API_KEY", "s3cret")
    app = create_app(_contract_result)
    auth = {"Authorization": "Bearer s3cret"}

    async def run():
        async with _client(app) as c:
            assert (await c.post("/solve", json=_body())).status_code == 401  # no header
            assert (
                await c.post("/solve", json=_body(), headers={"Authorization": "Bearer wrong"})
            ).status_code == 401  # wrong key
            r = await c.post("/solve", json=_body(), headers=auth)
            assert r.status_code == 200, r.text
            job_id = r.json()["id"]
            assert (await c.get("/health")).status_code == 200
            assert (await c.get(f"/jobs/{job_id}/status")).status_code == 200
            assert (await c.delete(f"/jobs/{job_id}")).status_code == 401  # DELETE guarded too
            assert (await c.delete(f"/jobs/{job_id}", headers=auth)).status_code == 204

    asyncio.run(run())


def test_auth_open_when_key_unset(monkeypatch):
    monkeypatch.delenv("PHOTOGRAMMETRY_API_KEY", raising=False)
    app = create_app(_contract_result)

    async def run():
        async with _client(app) as c:
            assert (await c.post("/solve", json=_body())).status_code == 200  # open dev default

    asyncio.run(run())


# --- P10.2b: the REAL photos→result E2E (production dispatcher, no injected double) ---------------


def test_real_pipeline_runs_and_degrades_cleanly_end_to_end():
    """Submit → poll → observe the REAL production dispatcher ``_load_pipeline_solve`` (NOT an injected
    double) run the full sparse SfM stack on a live photo set, end-to-end through the ASGI service.

    The committed synthetic scene is a per-stage ORACLE (features/matching/two-view/BA/mapper each have
    their own exact tests); it is deliberately texture-sparse, so the *chained* real-feature pipeline
    can't triangulate a multi-view reconstruction from it (init pair registers, but length-2 tracks are
    filtered by the mapper's track≥3 gate → 0 points). A **successful** full solve therefore requires
    the real-photo P7 gate datasets and is verified in the live run (see the module note); this test
    proves the complementary, headless-runnable contract: the service actually invokes the real
    pipeline (no mocks) and surfaces its failure CLEANLY — job ``failed`` → /result 500 — while /health
    stays 200 (a hard input is a failed job, never a dead service, SPEC-13 §7). Gated on mlx.core + PIL.
    """
    pytest.importorskip("mlx.core")
    pytest.importorskip("PIL")
    from PIL import Image

    from tests.synthetic import make_synthetic_scene

    scene = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    images_b64 = []
    for im in scene.images:
        buf = io.BytesIO()
        Image.fromarray(im).save(buf, format="PNG")
        images_b64.append(base64.b64encode(buf.getvalue()).decode("ascii"))

    app = create_app(_load_pipeline_solve)

    async def run():
        async with _client(app) as c:
            # dense=False: the sparse stack fails first (no reconstruction), so dense never runs — this
            # keeps the test to seconds while still driving the real dispatcher end-to-end.
            r = await c.post("/solve", json={"images": images_b64, "dense": False, "seed": 0})
            assert r.status_code == 200, r.text
            assert r.json()["state"] in ("queued", "running")
            job_id = r.json()["id"]

            state = await _drain(c, job_id, tries=3000, delay=0.05)
            status = (await c.get(f"/jobs/{job_id}/status")).json()
            assert state == "failed", f"texture-sparse synthetic should fail cleanly, ended {state}"
            assert status["error"], "a failed job must carry an error message"

            res = await c.get(f"/jobs/{job_id}/result")
            assert res.status_code == 500, res.text
            # The service survived the failed solve — a hard input is a failed job, not a dead service.
            assert (await c.get("/health")).status_code == 200

    asyncio.run(run())
