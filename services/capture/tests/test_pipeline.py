"""M7 — capture pipeline: oriented point cloud → watertight mesh (GLB) via the MLX SDF."""

import numpy as np
import pytest

pytest.importorskip("mlx.core")
pytest.importorskip("skimage")
import trimesh  # noqa: E402

from app.pipeline import reconstruct_surface  # noqa: E402


def _sphere_cloud(n: int = 2048, r: float = 1.0, seed: int = 0):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, 3))
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    return (x * r).astype(np.float32), x.astype(np.float32)


def test_point_cloud_reconstructs_to_a_mesh():
    pts, nrm = _sphere_cloud()
    res = reconstruct_surface(pts, nrm, iters=400, grid_res=48, seed=0)
    assert res.faces > 100
    assert res.vertices > 50
    # the mesh tracks the unit sphere it was trained on
    radii = np.linalg.norm(res.mesh.vertices - res.mesh.vertices.mean(axis=0), axis=1)
    assert 0.7 < float(radii.mean()) < 1.3


def test_result_exports_a_valid_glb():
    pts, nrm = _sphere_cloud()
    glb = reconstruct_surface(pts, nrm, iters=200, grid_res=40, seed=0).to_glb()
    assert isinstance(glb, (bytes, bytearray))
    assert len(glb) > 0
    # round-trips through trimesh as a real mesh
    loaded = trimesh.load(trimesh.util.wrap_as_stream(glb), file_type="glb", force="mesh")
    assert len(loaded.faces) > 0
