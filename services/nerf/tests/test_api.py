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


def test_train_hashgrid_with_importance_end_to_end():
    # 11-L1: the hash-grid encoding + PDF importance sampling are reachable from the wire — submit a
    # nerf job with both, poll to completion, and get a real GLB whose result echoes the effective
    # settings the served model trained with.
    async def run():
        imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=6, h=16, w=16)
        images = [_b64_png(imgs[i]) for i in range(len(imgs))]
        async with _client() as c:
            r = await c.post(
                "/train",
                json={
                    "transforms_json": json.dumps(transforms),
                    "images": images,
                    "iters": 150,
                    "method": "nerf",
                    "grid_res": 24,
                    "encoding": "hashgrid",
                    "importance_samples": 8,
                },
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
            assert body["method"] == "nerf" and body["iters"] == 150
            assert body["encoding"] == "hashgrid"  # the effective settings, additively in the result
            assert body["importance_samples"] == 8
            assert body["vertices"] > 0 and body["faces"] > 0
            assert base64.b64decode(body["glb_base64"])[:4] == b"glTF"

    asyncio.run(run())


def test_train_rejects_invalid_encoding_and_importance_samples():
    # New fields are schema-validated (422) before any decode/training work.
    async def run():
        imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=2, h=8, w=8)
        images = [_b64_png(imgs[i]) for i in range(2)]
        base = {"transforms_json": json.dumps(transforms), "images": images}
        async with _client() as c:
            for bad in (
                {"encoding": "fourier"},  # not in the Literal
                {"importance_samples": -1},  # ge=0
                {"importance_samples": 129},  # le=MAX_IMPORTANCE_SAMPLES (memory cap)
            ):
                r = await c.post("/train", json={**base, **bad})
                assert r.status_code == 422, f"{bad} → {r.status_code}: {r.text}"

    asyncio.run(run())


def test_train_rejects_hashgrid_with_neus():
    # The hash grid is the NeRF position encoding; the neus SDF trunk consumes raw coordinates by
    # design — the combination is rejected (422) rather than silently ignored.
    async def run():
        imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=2, h=8, w=8)
        images = [_b64_png(imgs[i]) for i in range(2)]
        async with _client() as c:
            r = await c.post(
                "/train",
                json={
                    "transforms_json": json.dumps(transforms),
                    "images": images,
                    "method": "neus",
                    "encoding": "hashgrid",
                },
            )
            assert r.status_code == 422
            assert "requires method 'nerf'" in r.text

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


def test_train_rejects_oversized_grid_res():
    # grid_res flows into a res^3 grid alloc — an unbounded value is a memory-exhaustion DoS.
    async def run():
        imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=2, h=8, w=8)
        images = [_b64_png(imgs[i]) for i in range(2)]
        async with _client() as c:
            r = await c.post(
                "/train",
                json={"transforms_json": json.dumps(transforms), "images": images, "grid_res": 9999},
            )
            assert r.status_code == 422  # pydantic Field le=MAX_GRID_RES

    asyncio.run(run())


def test_train_rejects_malformed_transforms_json():
    async def run():
        async with _client() as c:
            r = await c.post("/train", json={"transforms_json": "{not valid", "images": []})
            assert r.status_code == 400
            assert "valid JSON" in r.json()["detail"]

    asyncio.run(run())


def test_train_rejects_too_many_images():
    # The image-count cap fires at the schema layer, before any decode work.
    async def run():
        async with _client() as c:
            r = await c.post(
                "/train",
                json={"transforms_json": json.dumps({"frames": []}), "images": ["x"] * 301},
            )
            assert r.status_code == 422  # pydantic max_length=MAX_IMAGES

    asyncio.run(run())


def test_delete_removes_a_job():
    async def run():
        imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=6, h=16, w=16)
        images = [_b64_png(imgs[i]) for i in range(len(imgs))]
        async with _client() as c:
            r = await c.post(
                "/train",
                json={"transforms_json": json.dumps(transforms), "images": images, "iters": 40, "grid_res": 20},
            )
            job_id = r.json()["id"]
            d = await c.delete(f"/jobs/{job_id}")
            assert d.status_code == 204
            # The record is gone (the in-flight worker thread runs to completion but its result is discarded).
            assert (await c.get(f"/jobs/{job_id}/status")).status_code == 404

    asyncio.run(run())
