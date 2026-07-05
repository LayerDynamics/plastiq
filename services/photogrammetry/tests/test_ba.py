"""Tests for app/core/ba.py — bundle-adjustment residuals, parameterization, and Jacobian sparsity
(P4.1). The optimization loop itself is P4.2 (appended to ba.py later); here we prove the residual
model is exact at ground truth, the parameter packing round-trips, and the analytic sparsity pattern
matches a finite-difference Jacobian's nonzero pattern.
"""

from __future__ import annotations

import numpy as np

from app.core import ba
from tests.synthetic import make_synthetic_scene


def _scene_problem(n_views=6, seed=0):
    """Build a (intrinsics, cam_params, points, observations) ground-truth BA problem from the scene."""
    s = make_synthetic_scene(n_views=n_views, height=96, width=96, seed=seed)
    f = s.K[0, 0]
    cx, cy = s.K[0, 2], s.K[1, 2]
    intrinsics = np.array([f, cx, cy, 0.0, 0.0, 0.0, 0.0])  # zero distortion for the GT problem
    cam_params = np.zeros((n_views, 6))
    for i in range(n_views):
        R, t = s.poses_w2c[i][:, :3], s.poses_w2c[i][:, 3]
        cam_params[i, :3] = ba.inverse_rodrigues(R)
        cam_params[i, 3:] = t
    points = s.points3d.copy()
    obs = []
    for m, observations in enumerate(s.visibility):
        for (view, u, v) in observations:
            obs.append((view, m, u, v))
    observations = np.array(obs, dtype=np.float64)
    return intrinsics, cam_params, points, observations, s


def test_rodrigues_roundtrip():
    for rvec in [np.array([0.0, 0.0, 0.0]), np.array([0.1, -0.2, 0.3]), np.array([1.2, 0.0, -0.7])]:
        R = ba.rodrigues(rvec)
        assert np.allclose(R @ R.T, np.eye(3), atol=1e-12)
        assert np.isclose(np.linalg.det(R), 1.0, atol=1e-12)
        assert np.allclose(ba.rodrigues(ba.inverse_rodrigues(R)), R, atol=1e-10)


def test_pack_unpack_roundtrip():
    intr, cams, pts, _obs, _s = _scene_problem()
    x = ba.pack(intr, cams, pts)
    assert x.shape == (7 + 6 * cams.shape[0] + 3 * pts.shape[0],)
    i2, c2, p2 = ba.unpack(x, cams.shape[0], pts.shape[0])
    assert np.array_equal(i2, intr)
    assert np.array_equal(c2, cams)
    assert np.array_equal(p2, pts)


def test_residuals_zero_at_ground_truth():
    intr, cams, pts, obs, _s = _scene_problem()
    x = ba.pack(intr, cams, pts)
    r = ba.residuals(x, obs, cams.shape[0], pts.shape[0])
    assert r.shape == (2 * obs.shape[0],)
    assert np.max(np.abs(r)) < 1e-6  # the projection model reproduces the observed pixels exactly


def test_residuals_move_when_perturbed():
    intr, cams, pts, obs, _s = _scene_problem()
    x = ba.pack(intr, cams, pts)
    x_bad = x.copy()
    x_bad[7:10] += 0.05  # nudge the first camera's rotation
    r = ba.residuals(x_bad, obs, cams.shape[0], pts.shape[0])
    assert np.max(np.abs(r)) > 1.0  # a real perturbation produces real reprojection error


def test_jacobian_sparsity_matches_finite_difference():
    # A small 3-camera / 10-point subproblem so the dense FD Jacobian is cheap.
    intr, cams, pts, obs, _s = _scene_problem(n_views=3)
    keep_pts = np.arange(10)
    mask = np.isin(obs[:, 1].astype(int), keep_pts)
    obs = obs[mask]
    pts = pts[:10]
    n_cams, n_pts = 3, 10
    x = ba.pack(intr, cams, pts)

    spar = ba.jacobian_sparsity(obs, n_cams, n_pts)
    spar = np.asarray(spar.todense()) != 0

    # Finite-difference nonzero pattern.
    r0 = ba.residuals(x, obs, n_cams, n_pts)
    fd = np.zeros((r0.size, x.size))
    eps = 1e-6
    for j in range(x.size):
        xj = x.copy()
        xj[j] += eps
        fd[:, j] = (ba.residuals(xj, obs, n_cams, n_pts) - r0) / eps
    fd_pattern = np.abs(fd) > 1e-6

    # Every FD-nonzero entry must be marked in the analytic sparsity (analytic may be a superset).
    assert np.all(spar[fd_pattern])
    # And the analytic pattern must not be wildly over-dense: each residual row touches ≤ 16 params.
    assert spar.sum(axis=1).max() <= 16
