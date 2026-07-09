"""M7 — capture API: submit an oriented point cloud → poll → fetch the GLB, over the ASGI app (no
mocks), via httpx ASGITransport on asyncio.run so background jobs progress. Mirrors the reconstruct
service's API test. Also covers the M6 depth-scan front-end (/points-from-depth): synthetic depth
maps of a known plane/sphere where app/geometry.py's math predicts the exact cloud, fed into the
real /capture pipeline. Gated on fastapi + mlx so it self-skips where the capture env isn't
installed."""

import asyncio
import base64
import json

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


def test_too_many_points_is_422(monkeypatch):
    # the CAPTURE_MAX_POINTS cap (main.MAX_POINTS) rejects oversized clouds before any MLX work;
    # shrink it so the test payload stays tiny
    from app import main as app_main

    monkeypatch.setattr(app_main, "MAX_POINTS", 64)
    pts = [[0.0, 0.0, 1.0]] * 65

    async def run():
        async with _client() as c:
            r = await c.post("/capture", json={"points": pts, "normals": pts})
            assert r.status_code == 422
            r = await c.post("/complete", json={"points": pts})
            assert r.status_code == 422

    asyncio.run(run())


def test_delete_job_is_204_then_404():
    async def run():
        pts, nrm = _sphere(32)
        async with _client() as c:
            r = await c.post("/capture", json={"points": pts, "normals": nrm, "iters": 5, "grid_res": 16})
            assert r.status_code == 200
            job_id = r.json()["id"]
            r = await c.delete(f"/jobs/{job_id}")
            assert r.status_code == 204
            # the record is gone: status/result 404, and a second delete is a 404 too
            assert (await c.get(f"/jobs/{job_id}/status")).status_code == 404
            assert (await c.get(f"/jobs/{job_id}/result")).status_code == 404
            assert (await c.delete(f"/jobs/{job_id}")).status_code == 404

    asyncio.run(run())


def test_delete_unknown_job_is_404():
    async def run():
        async with _client() as c:
            assert (await c.delete("/jobs/does-not-exist")).status_code == 404

    asyncio.run(run())


def test_submits_beyond_the_concurrency_cap_are_429(monkeypatch):
    # the CAPTURE_MAX_CONCURRENT_JOBS cap (main._MAX_CONCURRENT) bounds how many MLX fits can be in
    # flight at once; force it to 0 so ANY submit is over the cap without running real jobs
    from app import main as app_main

    monkeypatch.setattr(app_main, "_MAX_CONCURRENT", 0)
    pts, nrm = _sphere(32)

    async def run():
        async with _client() as c:
            r = await c.post("/capture", json={"points": pts, "normals": nrm})
            assert r.status_code == 429
            assert "in flight" in r.json()["detail"]
            r = await c.post("/complete", json={"points": pts})
            assert r.status_code == 429
            assert "in flight" in r.json()["detail"]

    asyncio.run(run())


def test_points_from_depth_frontoparallel_plane():
    # a constant-depth map is a frontoparallel plane: geometry.py's math predicts every point at
    # z = 0.5 and every normal exactly (0, 0, -1) (toward the camera) — including the edges, since
    # the unprojected grid is planar so the one-sided edge gradients equal the interior ones
    h, w, z = 8, 8, 0.5
    body = {"depth": [[z] * w for _ in range(h)], "fx": 100.0, "fy": 100.0, "cx": (w - 1) / 2, "cy": (h - 1) / 2}

    async def run():
        async with _client() as c:
            r = await c.post("/points-from-depth", json=body)
            assert r.status_code == 200
            out = r.json()
            pts = np.asarray(out["points"])
            nrm = np.asarray(out["normals"])
            assert pts.shape == (h * w, 3) and nrm.shape == (h * w, 3)
            assert np.allclose(pts[:, 2], z)
            assert np.allclose(nrm, [0.0, 0.0, -1.0], atol=1e-6)
            grid = pts.reshape(h, w, 3)
            assert grid[0, 0, 0] < 0 < grid[-1, -1, 0]  # row-major over (v, u), straddling the axis
            assert grid[0, 0, 1] < 0 < grid[-1, -1, 1]

    asyncio.run(run())


def test_points_from_depth_sphere_feeds_capture_end_to_end():
    # a synthetic z-depth map of a sphere at (0, 0, z0): along the pixel ray p(t) = t·((u−cx)/fx,
    # (v−cy)/fy, 1) the first hit solves |p − c|² = r², i.e. t = (z0 − sqrt(z0² − a·(z0² − r²)))/a
    # with a = |ray|² — so geometry.py's math predicts on-sphere points with outward normals
    h = w = 16
    fx = fy = 20.0
    cx, cy = (w - 1) / 2, (h - 1) / 2
    z0, radius = 0.5, 0.4
    u, v = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    rx, ry = (u - cx) / fx, (v - cy) / fy
    a = rx * rx + ry * ry + 1.0
    disc = z0 * z0 - a * (z0 * z0 - radius * radius)
    assert (disc > 0).all()  # the sphere covers every pixel
    depth = (z0 - np.sqrt(disc)) / a

    async def run():
        async with _client() as c:
            r = await c.post(
                "/points-from-depth", json={"depth": depth.tolist(), "fx": fx, "fy": fy, "cx": cx, "cy": cy}
            )
            assert r.status_code == 200
            cloud = r.json()
            pts = np.asarray(cloud["points"])
            nrm = np.asarray(cloud["normals"])
            # every unprojected point sits on the sphere...
            assert np.allclose(np.linalg.norm(pts - [0, 0, z0], axis=1), radius, atol=1e-3)
            # ...and interior normals match the sphere's outward normals (p − c)/r — toward the
            # camera IS outward for a surface seen from outside (edges use one-sided gradients)
            outward = ((pts - [0, 0, z0]) / radius).reshape(h, w, 3)
            cos = (nrm.reshape(h, w, 3)[2:-2, 2:-2] * outward[2:-2, 2:-2]).sum(axis=-1)
            assert cos.min() > 0.99
            # the response body is exactly /capture's input shape — run the real pipeline on it
            r = await c.post("/capture", json={**cloud, "iters": 150, "grid_res": 32})
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


def test_points_from_depth_validation_errors_are_400():
    base = {"fx": 20.0, "fy": 20.0, "cx": 0.5, "cy": 0.5}
    ok = [[0.5, 0.5], [0.5, 0.5]]

    async def run():
        async with _client() as c:
            # ragged rows
            r = await c.post("/points-from-depth", json={"depth": [[0.5, 0.5], [0.5]], **base})
            assert r.status_code == 400
            # not an (H>=2, W>=2) map — normals need gradients along both axes
            r = await c.post("/points-from-depth", json={"depth": [[0.5, 0.5, 0.5]], **base})
            assert r.status_code == 400
            # non-finite depth — httpx's json= refuses NaN (allow_nan=False), so post the raw body:
            # stdlib json.dumps emits a NaN token, which the server's parser accepts and pydantic
            # passes through as float('nan'), exercising the endpoint's own finiteness check
            payload = json.dumps({"depth": [[0.5, float("nan")], [0.5, 0.5]], **base})
            r = await c.post(
                "/points-from-depth", content=payload, headers={"content-type": "application/json"}
            )
            assert r.status_code == 400
            # non-positive depth (sensor holes must be cropped/filled upstream)
            r = await c.post("/points-from-depth", json={"depth": [[0.5, 0.0], [0.5, 0.5]], **base})
            assert r.status_code == 400
            # degenerate intrinsics (fx = 0 would divide by zero in the unprojection)
            r = await c.post("/points-from-depth", json={"depth": ok, **{**base, "fx": 0.0}})
            assert r.status_code == 400

    asyncio.run(run())


def test_points_from_depth_beyond_the_pixel_cap_is_422(monkeypatch):
    # depth maps share /capture's CAPTURE_MAX_POINTS budget (every pixel becomes a point); shrink it
    # so the test payload stays tiny
    from app import main as app_main

    monkeypatch.setattr(app_main, "MAX_POINTS", 64)
    depth = [[0.5] * 9 for _ in range(9)]  # 81 pixels > 64

    async def run():
        async with _client() as c:
            r = await c.post("/points-from-depth", json={"depth": depth, "fx": 20.0, "fy": 20.0, "cx": 4.0, "cy": 4.0})
            assert r.status_code == 422

    asyncio.run(run())


def test_complete_submit_poll_result_end_to_end(monkeypatch):
    # keep the lazily-trained demo model fast for the test
    monkeypatch.setenv("CAPTURE_COMPLETION_ITERS", "120")

    async def run():
        rng = np.random.default_rng(3)
        pts = []
        while len(pts) < 256:
            x = rng.normal(size=3)
            x /= np.linalg.norm(x)
            if x[2] > 0.05:  # a partial (top-hemisphere) scan
                pts.append((x * 0.8).tolist())
        async with _client() as c:
            r = await c.post("/complete", json={"points": pts, "grid_res": 32})
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
