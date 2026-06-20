"""End-to-end API: submit a real GLB → poll → fetch the STEP, over the ASGI app (no
mocks). Driven with httpx ASGITransport on asyncio.run so background jobs progress."""

import asyncio
import base64

import httpx
import trimesh
from httpx import ASGITransport

from app.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def _cube_glb_b64(size: float = 0.02) -> str:
    glb = trimesh.creation.box(extents=(size, size, size)).export(file_type="glb")
    return base64.b64encode(glb).decode()


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
