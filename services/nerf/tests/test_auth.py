"""11-M4 — bearer auth on the mutating endpoints (POST /train, DELETE /jobs/{id}), over the real ASGI
app (no mocks) like test_api.py.

NERF_API_KEY is read per-request (not at import), so monkeypatch.setenv drives the real code path:
key set ⇒ 401 without / with a wrong bearer and success with the correct one; key unset ⇒ open (the
dev default). The 401 cases also prove ordering — the auth dependency rejects BEFORE any job work, so
no training run is needed and the job store is untouched."""

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

from app.main import app, store  # noqa: E402
from tests.synthetic import make_synthetic_dataset  # noqa: E402

KEY = "test-secret-key"


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def _b64_png(img: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray((np.clip(img, 0.0, 1.0) * 255).astype(np.uint8)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _tiny_train_body() -> dict:
    """A schema-valid /train body kept as small as the caps allow (2 views, 8×8, 1 iter, 16³ grid) —
    the authorized submits stay fast and the rejected ones never reach it anyway."""
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=2, h=8, w=8)
    return {
        "transforms_json": json.dumps(transforms),
        "images": [_b64_png(imgs[i]) for i in range(len(imgs))],
        "iters": 1,
        "grid_res": 16,
    }


def test_train_rejects_missing_and_wrong_bearer_when_key_set(monkeypatch):
    monkeypatch.setenv("NERF_API_KEY", KEY)
    body = _tiny_train_body()

    async def run():
        async with _client() as c:
            before_ids = set(store._jobs)
            r = await c.post("/train", json=body)  # no Authorization header at all
            assert r.status_code == 401
            r = await c.post("/train", json=body, headers={"Authorization": f"Bearer wrong-{KEY}"})
            assert r.status_code == 401
            r = await c.post("/train", json=body, headers={"Authorization": KEY})  # missing Bearer scheme
            assert r.status_code == 401
            # Auth precedes any job work: none of the rejected requests submitted a job.
            assert set(store._jobs) == before_ids

    asyncio.run(run())


def test_delete_rejects_missing_and_wrong_bearer_when_key_set(monkeypatch):
    monkeypatch.setenv("NERF_API_KEY", KEY)

    async def run():
        async with _client() as c:
            # 401 even for a nonexistent id — the auth dependency runs before the handler's 404.
            r = await c.delete("/jobs/no-such-job")
            assert r.status_code == 401
            r = await c.delete("/jobs/no-such-job", headers={"Authorization": "Bearer nope"})
            assert r.status_code == 401
            r = await c.delete("/jobs/no-such-job", headers={"Authorization": f"Bearer {KEY}"})
            assert r.status_code == 404  # authorized — now the handler runs and the id is unknown

    asyncio.run(run())


def test_correct_bearer_allows_train_and_delete(monkeypatch):
    monkeypatch.setenv("NERF_API_KEY", KEY)
    body = _tiny_train_body()

    async def run():
        async with _client() as c:
            auth = {"Authorization": f"Bearer {KEY}"}
            r = await c.post("/train", json=body, headers=auth)
            assert r.status_code == 200, r.text
            job_id = r.json()["id"]
            d = await c.delete(f"/jobs/{job_id}", headers=auth)
            assert d.status_code == 204

    asyncio.run(run())


def test_unset_key_leaves_endpoints_open(monkeypatch):
    monkeypatch.delenv("NERF_API_KEY", raising=False)
    body = _tiny_train_body()

    async def run():
        async with _client() as c:
            r = await c.post("/train", json=body)  # no auth header — dev default is open
            assert r.status_code == 200, r.text
            job_id = r.json()["id"]
            d = await c.delete(f"/jobs/{job_id}")
            assert d.status_code == 204

    asyncio.run(run())
