"""M7 — capture API: submit an oriented point cloud → poll → fetch the GLB, over the ASGI app (no
mocks), via httpx ASGITransport on asyncio.run so background jobs progress. Mirrors the reconstruct
service's API test. Gated on fastapi + mlx so it self-skips where the capture env isn't installed."""

import asyncio
import base64

import numpy as np
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("mlx.core")
import httpx  # noqa: E402
from httpx import ASGITransport  # noqa: E402

from app.main import app  # noqa: E402


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def _sphere(n: int = 512):
    rng = np.random.default_rng(0)
    x = rng.normal(size=(n, 3))
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    return x.tolist(), x.tolist()  # points, outward normals


def test_health():
    async def run():
        async with _client() as c:
            r = await c.get("/health")
            assert r.status_code == 200
            assert r.json()["status"] == "ok"

    asyncio.run(run())


def test_capture_submit_poll_result_end_to_end():
    async def run():
        pts, nrm = _sphere()
        async with _client() as c:
            r = await c.post("/capture", json={"points": pts, "normals": nrm, "iters": 150, "grid_res": 32})
            assert r.status_code == 200
            job_id = r.json()["id"]

            state = "queued"
            for _ in range(600):
                state = (await c.get(f"/jobs/{job_id}/status")).json()["state"]
                if state in ("completed", "failed"):
                    break
                await asyncio.sleep(0.05)
            assert state == "completed", f"job ended in {state}"

            body = (await c.get(f"/jobs/{job_id}/result")).json()
            assert body["faces"] > 0
            assert len(base64.b64decode(body["glb_base64"])) > 0

    asyncio.run(run())


def test_mismatched_point_cloud_is_400():
    async def run():
        async with _client() as c:
            r = await c.post("/capture", json={"points": [[0, 0, 0]], "normals": [[0, 0, 1], [0, 1, 0]]})
            assert r.status_code == 400

    asyncio.run(run())
