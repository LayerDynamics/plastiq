"""M7 — MLX neural-SDF surface reconstruction (app/sdf_mlx.py). Trains a SIREN SDF on an oriented
point cloud (the IGR losses) and marching-cubes the zero level-set into a mesh. Runs REAL MLX
training on Apple Silicon (the M4 Max) — not a stub. See docs/adr/0007.
"""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")
pytest.importorskip("skimage")

from app.sdf_mlx import extract_mesh, fit_sdf  # noqa: E402


def _sphere_cloud(n: int = 2048, r: float = 1.0, seed: int = 0):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, 3))
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    return (x * r).astype(np.float32), x.astype(np.float32)  # points, outward unit normals


def test_fit_sdf_on_a_sphere_recovers_a_spherical_mesh():
    pts, nrm = _sphere_cloud()
    net = fit_sdf(pts, nrm, iters=600, seed=0)
    verts, faces = extract_mesh(net, bound=1.6, res=48)
    assert len(faces) > 100  # a real surface was extracted
    radii = np.linalg.norm(verts - verts.mean(axis=0), axis=1)
    assert 0.7 < float(radii.mean()) < 1.3  # roughly the unit sphere it was trained on


def test_sdf_is_negative_inside_and_positive_outside():
    pts, nrm = _sphere_cloud()
    net = fit_sdf(pts, nrm, iters=600, seed=0)
    inside = float(net(mx.array([[0.0, 0.0, 0.0]]))[0, 0])
    outside = float(net(mx.array([[3.0, 0.0, 0.0]]))[0, 0])
    assert inside < 0.0 < outside


def test_fit_is_deterministic_with_a_seed():
    pts, nrm = _sphere_cloud()
    a = fit_sdf(pts, nrm, iters=40, seed=7)
    b = fit_sdf(pts, nrm, iters=40, seed=7)
    q = mx.array([[0.5, 0.1, 0.2]])
    assert abs(float(a(q)[0, 0]) - float(b(q)[0, 0])) < 1e-5
