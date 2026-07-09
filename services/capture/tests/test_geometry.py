"""M6 — camera + depth math (app/geometry.py), ported (Apache-2.0) from kornia's depth_to_3d /
depth_to_normals, in MLX (Apple Silicon). The functions return mlx.core arrays; the tests convert
to numpy (np.asarray) for assertions. See docs/adr/0006.
"""

import numpy as np
import pytest

pytest.importorskip("mlx.core")

from app.geometry import PinholeCamera, depth_to_normals, unproject_depth  # noqa: E402


def _cam(h: int = 8, w: int = 8) -> PinholeCamera:
    return PinholeCamera(fx=100.0, fy=100.0, cx=(w - 1) / 2, cy=(h - 1) / 2)


def test_unproject_constant_depth_is_a_frontoparallel_plane():
    cam = _cam()
    depth = np.full((8, 8), 0.5)
    pts = np.asarray(unproject_depth(depth, cam))
    assert pts.shape == (8, 8, 3)
    assert np.allclose(pts[..., 2], 0.5)  # every point at depth z=0.5
    # the principal point is at the (fractional) centre, so corners straddle the optical axis
    assert pts[0, 0, 0] < 0 and pts[0, 0, 1] < 0  # top-left is at -x,-y
    assert pts[-1, -1, 0] > 0 and pts[-1, -1, 1] > 0  # bottom-right is at +x,+y


def test_project_unproject_roundtrip():
    cam = _cam()
    P = np.array([0.03, -0.02, 0.5])  # a 3D point in front of the camera
    u, v = cam.project(P)
    back = np.asarray(cam.unproject(u, v, P[2]))
    assert np.allclose(back, P, atol=1e-6)


def test_normals_of_a_frontoparallel_plane_point_at_the_camera():
    cam = _cam()
    depth = np.full((8, 8), 0.5)
    n = np.asarray(depth_to_normals(depth, cam))
    interior = n[1:-1, 1:-1]  # gradients are defined in the interior
    assert np.allclose(interior, np.array([0.0, 0.0, -1.0]), atol=1e-6)  # toward the camera (−z)


def test_normals_are_unit_length():
    cam = _cam()
    rng = np.random.default_rng(0)
    depth = 0.5 + 0.01 * rng.random((8, 8))
    n = np.asarray(depth_to_normals(depth, cam))
    lengths = np.linalg.norm(n[1:-1, 1:-1], axis=-1)
    assert np.allclose(lengths, 1.0, atol=1e-5)


def test_normals_of_a_tilted_plane_tilt_with_it():
    cam = _cam()
    # depth increases linearly across columns → the plane is tilted about the y-axis, so the normal
    # gains an x-component (and still points toward the camera).
    u = np.arange(8)
    depth = 0.5 + 0.002 * (u - cam.cx)[None, :] * np.ones((8, 1))
    n = np.asarray(depth_to_normals(depth, cam))
    interior = n[1:-1, 1:-1]
    assert np.all(interior[..., 2] < 0)  # toward the camera
    assert np.abs(interior[..., 0]).mean() > 1e-3  # tilted → nonzero x


def test_unproject_is_deterministic():
    cam = _cam()
    depth = np.full((8, 8), 0.4)
    a = np.asarray(unproject_depth(depth, cam))
    b = np.asarray(unproject_depth(depth, cam))
    assert np.array_equal(a, b)
