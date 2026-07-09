"""End-to-end API: submit a real GLB → poll → fetch the STEP, over the ASGI app (no
mocks). Driven with httpx ASGITransport on asyncio.run so background jobs progress."""

import asyncio
import base64

import httpx
import trimesh
from httpx import ASGITransport

from app import main as app_main
from app.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def _cube_glb_b64(size: float = 0.02) -> str:
    glb = trimesh.creation.box(extents=(size, size, size)).export(file_type="glb")
    return base64.b64encode(glb).decode()


async def _poll_terminal(c: httpx.AsyncClient, job_id: str) -> str:
    state = "queued"
    for _ in range(200):
        state = (await c.get(f"/jobs/{job_id}/status")).json()["state"]
        if state in ("completed", "failed"):
            break
        await asyncio.sleep(0.05)
    return state


def test_health():
    async def run():
        async with _client() as c:
            r = await c.get("/health")
            assert r.status_code == 200
            assert r.json()["status"] == "ok"

    asyncio.run(run())


def test_submit_poll_result_end_to_end():
    async def run():
        async with _client() as c:
            r = await c.post("/reconstruct", json={"glb_base64": _cube_glb_b64()})
            assert r.status_code == 200
            job_id = r.json()["id"]

            state = "queued"
            for _ in range(200):
                state = (await c.get(f"/jobs/{job_id}/status")).json()["state"]
                if state in ("completed", "failed"):
                    break
                await asyncio.sleep(0.05)
            assert state == "completed", f"job ended in {state}"

            res = await c.get(f"/jobs/{job_id}/result")
            assert res.status_code == 200
            body = res.json()
            assert body["step"].startswith("ISO-10303-21")
            assert body["report"]["is_valid"] is True
            assert body["report"]["is_solid"] is True

    asyncio.run(run())


def test_method_param_round_trips_faceted_and_fitted():
    # SPEC-7 FR-11: the request's `method` selects the route; the report echoes the route taken.
    async def run():
        async with _client() as c:
            for method in ("faceted", "fitted"):
                r = await c.post("/reconstruct", json={"glb_base64": _cube_glb_b64(), "method": method})
                assert r.status_code == 200
                job_id = r.json()["id"]
                assert await _poll_terminal(c, job_id) == "completed"
                body = (await c.get(f"/jobs/{job_id}/result")).json()
                assert body["report"]["method"] == method
                assert body["step"].startswith("ISO-10303-21")

    asyncio.run(run())


def test_unknown_method_is_422():
    async def run():
        async with _client() as c:
            r = await c.post("/reconstruct", json={"glb_base64": _cube_glb_b64(), "method": "banana"})
            assert r.status_code == 422

    asyncio.run(run())


def test_delete_job_removes_it_and_unknown_is_404():
    async def run():
        async with _client() as c:
            r = await c.post("/reconstruct", json={"glb_base64": _cube_glb_b64()})
            job_id = r.json()["id"]
            assert (await c.delete(f"/jobs/{job_id}")).status_code == 204
            assert (await c.get(f"/jobs/{job_id}/status")).status_code == 404  # record dropped
            assert (await c.delete(f"/jobs/{job_id}")).status_code == 404  # already gone
            assert (await c.delete("/jobs/does-not-exist")).status_code == 404

    asyncio.run(run())


def test_submit_beyond_the_concurrency_cap_is_429(monkeypatch):
    monkeypatch.setattr(app_main, "_MAX_CONCURRENT", 0)  # any in-flight count now exceeds the cap

    async def run():
        async with _client() as c:
            r = await c.post("/reconstruct", json={"glb_base64": _cube_glb_b64()})
            assert r.status_code == 429
            assert "in flight" in r.json()["detail"]

    asyncio.run(run())


def test_invalid_base64_is_400():
    async def run():
        async with _client() as c:
            r = await c.post("/reconstruct", json={"glb_base64": "!!! not base64 !!!"})
            assert r.status_code == 400

    asyncio.run(run())


def test_unknown_job_is_404():
    async def run():
        async with _client() as c:
            assert (await c.get("/jobs/does-not-exist/status")).status_code == 404
            assert (await c.get("/jobs/does-not-exist/result")).status_code == 404

    asyncio.run(run())


def test_cors_headers_present_for_browser_origin():
    # the browser client is cross-origin → the service must echo CORS headers (R6.7b)
    async def run():
        async with _client() as c:
            r = await c.options(
                "/reconstruct",
                headers={
                    "Origin": "http://localhost:4177",
                    "Access-Control-Request-Method": "POST",
                },
            )
            assert r.headers.get("access-control-allow-origin") in ("*", "http://localhost:4177")

    asyncio.run(run())
