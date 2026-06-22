"""N10.2 — the NeRF HTTP service: submit posed images → poll → fetch the GLB, over the real ASGI app
(no mocks) via httpx ASGITransport on asyncio.run so background jobs progress. Mirrors capture/
reconstruct API tests. Gated on fastapi + mlx so it self-skips where the web env isn't installed."""

import asyncio
import base64
import io
import json

import numpy as np
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("mlx.core")
pytest.importorskip("skimage.measure")
import httpx  # noqa: E402
from httpx import ASGITransport  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402
from tests.synthetic import make_synthetic_dataset  # noqa: E402


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def _b64_png(img: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray((np.clip(img, 0.0, 1.0) * 255).astype(np.uint8)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_health():
    async def run():
        async with _client() as c:
            r = await c.get("/health")
            assert r.status_code == 200
            assert r.json()["status"] == "ok"
            assert r.json()["service"] == "plastiq-nerf"

    asyncio.run(run())


def test_train_submit_poll_result_end_to_end():
    async def run():
        imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=6, h=16, w=16)
        images = [_b64_png(imgs[i]) for i in range(len(imgs))]
        async with _client() as c:
            r = await c.post(
                "/train",
                json={"transforms_json": json.dumps(transforms), "images": images, "iters": 120, "method": "neus", "grid_res": 24},
            )
            assert r.status_code == 200, r.text
            job_id = r.json()["id"]

            state = "queued"
            for _ in range(1200):
                state = (await c.get(f"/jobs/{job_id}/status")).json()["state"]
                if state in ("completed", "failed"):
                    break
                await asyncio.sleep(0.05)
            assert state == "completed", f"job ended in {state}: {(await c.get(f'/jobs/{job_id}/status')).json()}"

            body = (await c.get(f"/jobs/{job_id}/result")).json()
            assert body["method"] == "neus" and body["iters"] == 120
            assert body["vertices"] > 0 and body["faces"] > 0
            assert len(base64.b64decode(body["glb_base64"])) > 0

    asyncio.run(run())


def test_train_rejects_image_frame_mismatch():
    async def run():
        imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=4, h=16, w=16)
        images = [_b64_png(imgs[i]) for i in range(2)]  # 2 images vs 4 frames
        async with _client() as c:
            r = await c.post("/train", json={"transforms_json": json.dumps(transforms), "images": images})
            assert r.status_code == 400
            assert "parallel" in r.json()["detail"]

    asyncio.run(run())
