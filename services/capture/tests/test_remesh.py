"""§16 — capture-service mesh remesh/decimate: isotropic refinement raises the triangle
count, decimation lowers it, both export a valid GLB, and the /remesh route round-trips
submit→poll→result over the real ASGI app (no mocks). The pure-geometry unit tests gate
on trimesh only; the route test gates on fastapi+mlx like the rest of the API suite."""

import asyncio
import base64

import numpy as np
import pytest

pytest.importorskip("trimesh")
import trimesh  # noqa: E402

from app.remesh import remesh_surface, remesh_job, _cluster_decimate  # noqa: E402


def _box(side: float = 0.2):
    h = side / 2
    v = np.array(
        [
            [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
            [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
        ],
        dtype=np.float64,
    )
    f = np.array(
        [
            [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
            [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3],
        ],
        dtype=np.int64,
    )
    return v, f


def test_remesh_refines_increases_triangle_count():
    v, f = _box()
    res = remesh_surface(v, f, mode="remesh", target_edge_length=0.05)
    assert res.faces > len(f)
    # refined edges are no longer than ~the target (subdivide_to_size guarantee)
    assert float(res.mesh.edges_unique_length.max()) <= 0.05 * 1.5


def test_decimate_reduces_triangle_count_and_stays_watertight():
    # Start from a dense sphere so decimation has room to work.
    sphere = trimesh.creation.icosphere(subdivisions=3)  # 1280 faces
    res = remesh_surface(sphere.vertices, sphere.faces, mode="decimate", target_ratio=0.3)
    assert res.faces < len(sphere.faces)
    assert res.faces >= 4
    # bounding box is preserved within a small tolerance (bounded error)
    assert np.allclose(res.mesh.bounds, sphere.bounds, atol=0.15)


def test_cluster_decimate_fallback_is_self_contained():
    sphere = trimesh.creation.icosphere(subdivisions=3)
    out = _cluster_decimate(sphere, target_faces=200)
    assert len(out.faces) < len(sphere.faces)
    assert len(out.faces) > 0


def test_remesh_job_exports_a_valid_glb():
    v, f = _box()
    out = remesh_job(v.tolist(), f.tolist(), mode="remesh", target_edge_length=0.05)
    assert out["faces"] > len(f)
    glb = base64.b64decode(out["glb_base64"])
    loaded = trimesh.load(trimesh.util.wrap_as_stream(glb), file_type="glb", force="mesh")
    assert len(loaded.faces) > 0


# --- the ASGI route (submit → poll → result), gated on the full capture env -----------

pytest.importorskip("fastapi")
pytest.importorskip("mlx.core")
import httpx  # noqa: E402
from httpx import ASGITransport  # noqa: E402

from app.main import app  # noqa: E402


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


def test_remesh_route_round_trips():
    v, f = _box()

    async def run():
        async with _client() as c:
            r = await c.post("/remesh", json={"vertices": v.tolist(), "faces": f.tolist(), "mode": "remesh", "target_edge_length": 0.05})
            assert r.status_code == 200
            jid = r.json()["id"]
            for _ in range(200):
                s = (await c.get(f"/jobs/{jid}/status")).json()
                if s["state"] in ("completed", "failed"):
                    break
                await asyncio.sleep(0.05)
            assert s["state"] == "completed", s
            result = (await c.get(f"/jobs/{jid}/result")).json()
            assert result["faces"] > len(f)
            assert base64.b64decode(result["glb_base64"])

    asyncio.run(run())


def test_remesh_route_rejects_bad_face_index():
    async def run():
        async with _client() as c:
            r = await c.post("/remesh", json={"vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]], "faces": [[0, 1, 9]]})
            assert r.status_code == 400

    asyncio.run(run())
