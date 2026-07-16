"""Tests for app/core/pnp.py — DLT camera resection + LM refinement (P3.2, strict TDD).

The correctness bed is the synthetic ground-truth scene (``tests/synthetic.py`` — never modified
here). For a fixture view, its 3D↔2D correspondences are its visible landmarks and their exact
pixel projections; ``solve_pnp_dlt`` must recover that view's world-to-camera ``(R, t)`` exactly
(rotation angle < 1e-6°, translation < 1e-8) from the noise-free set. Under ~0.5px Gaussian noise
(seeded — D-10), ``refine_pnp`` (Levenberg-Marquardt) started from the DLT estimate must strictly
lower the mean reprojection error versus the DLT estimate alone. A coplanar-only correspondence set
(the fixture's ``y=0`` ground plane) must raise a clear ``ValueError`` rather than return a wrong
pose. Results are deterministic (NFR-1 — no RNG in the fixed-size CPU solver).

``cv2`` is used ONLY here as a parity oracle (SPEC-13 D-1 — never imported by ``app/``).
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core import pnp
from tests.synthetic import make_synthetic_scene, project_points

# A central arc view whose visible structure spans the ground plane AND the box (non-coplanar, so
# DLT is well-posed) — the demanding, correctly-conditioned resection the fixture offers.
_VIEW = 3


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _view_correspondences(scene, view: int):
    """``(points3d (K,3), points2d (K,2))``: landmarks visible in ``view`` and their exact pixels."""
    idx = [m for m, obs in enumerate(scene.visibility) if any(v == view for (v, _, _) in obs)]
    pts3d = scene.points3d[idx]
    uv, _ = project_points(pts3d, scene.K, scene.poses_w2c[view])
    return pts3d, uv


def _plane_correspondences(scene, view: int):
    """Ground-plane (``y=0``) landmarks visible in ``view`` and their exact pixels — coplanar."""
    idx = [
        m
        for m, obs in enumerate(scene.visibility)
        if abs(scene.points3d[m][1]) < 1e-9 and any(v == view for (v, _, _) in obs)
    ]
    pts3d = scene.points3d[idx]
    uv, _ = project_points(pts3d, scene.K, scene.poses_w2c[view])
    return pts3d, uv


def _angle_error_deg(r_est: np.ndarray, r_true: np.ndarray) -> float:
    """Geodesic rotation-angle error in degrees between two rotation matrices."""
    cos = (np.trace(r_est @ r_true.T) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def _mean_reproj_error(r, t, pts3d, pts2d, k) -> float:
    """Mean L2 pixel reprojection error of pose ``(R, t)`` against ``pts2d``."""
    pose = np.concatenate([r, t[:, None]], axis=1)
    uv, _ = project_points(pts3d, k, pose)
    return float(np.mean(np.linalg.norm(uv - pts2d, axis=1)))


# --- exact recovery on the synthetic ground truth ------------------------------------------------

def test_solve_pnp_dlt_recovers_noise_free_pose():
    scene = _scene()
    pts3d, pts2d = _view_correspondences(scene, _VIEW)
    assert pts3d.shape[0] >= 6

    r, t = pnp.solve_pnp_dlt(pts3d, pts2d, scene.K)
    assert r.shape == (3, 3)
    assert t.shape == (3,)

    r_true = scene.poses_w2c[_VIEW][:, :3]
    t_true = scene.poses_w2c[_VIEW][:, 3]
    assert _angle_error_deg(r, r_true) < 1e-6
    assert np.linalg.norm(t - t_true) < 1e-8


def test_solve_pnp_dlt_is_deterministic():
    scene = _scene()
    pts3d, pts2d = _view_correspondences(scene, _VIEW)
    r1, t1 = pnp.solve_pnp_dlt(pts3d, pts2d, scene.K)
    r2, t2 = pnp.solve_pnp_dlt(pts3d, pts2d, scene.K)
    # No RNG in a fixed-size CPU SVD — identical runs are bitwise-identical (NFR-1).
    assert np.array_equal(r1, r2)
    assert np.array_equal(t1, t2)


# --- refinement strictly improves on noisy data --------------------------------------------------

def test_refine_pnp_lowers_reprojection_error_under_noise():
    scene = _scene()
    pts3d, pts2d = _view_correspondences(scene, _VIEW)

    rng = np.random.default_rng(12345)
    noisy = pts2d + rng.normal(0.0, 0.5, size=pts2d.shape)

    r_dlt, t_dlt = pnp.solve_pnp_dlt(pts3d, noisy, scene.K)
    r_ref, t_ref = pnp.refine_pnp(r_dlt, t_dlt, pts3d, noisy, scene.K)

    err_dlt = _mean_reproj_error(r_dlt, t_dlt, pts3d, noisy, scene.K)
    err_ref = _mean_reproj_error(r_ref, t_ref, pts3d, noisy, scene.K)
    # LM minimizes the geometric error the DLT only approximates algebraically ⇒ strictly lower.
    assert err_ref < err_dlt
    assert r_ref.shape == (3, 3)
    assert t_ref.shape == (3,)


def test_refine_pnp_holds_near_optimum():
    """Refining an already-exact pose must not degrade it (stays sub-pixel)."""
    scene = _scene()
    pts3d, pts2d = _view_correspondences(scene, _VIEW)
    r_dlt, t_dlt = pnp.solve_pnp_dlt(pts3d, pts2d, scene.K)
    r_ref, t_ref = pnp.refine_pnp(r_dlt, t_dlt, pts3d, pts2d, scene.K)
    assert _mean_reproj_error(r_ref, t_ref, pts3d, pts2d, scene.K) < 1e-4


# --- coplanar degeneracy is a clear error, not a wrong pose --------------------------------------

def test_solve_pnp_dlt_raises_on_coplanar_points():
    scene = _scene()
    pts3d, pts2d = _plane_correspondences(scene, _VIEW)
    assert pts3d.shape[0] >= 6
    # All landmarks lie on y=0 ⇒ the DLT design is rank-deficient; must raise, not guess a pose.
    with pytest.raises(ValueError):
        pnp.solve_pnp_dlt(pts3d, pts2d, scene.K)


def test_solve_pnp_dlt_raises_on_too_few_points():
    scene = _scene()
    pts3d, pts2d = _view_correspondences(scene, _VIEW)
    with pytest.raises(ValueError):
        pnp.solve_pnp_dlt(pts3d[:5], pts2d[:5], scene.K)


# --- OpenCV parity (oracle; cv2 is test-only) ----------------------------------------------------

def test_opencv_solvepnp_parity():
    cv2 = pytest.importorskip("cv2")
    scene = _scene()
    pts3d, pts2d = _view_correspondences(scene, _VIEW)
    r_mine, t_mine = pnp.solve_pnp_dlt(pts3d, pts2d, scene.K)
    r_mine, t_mine = pnp.refine_pnp(r_mine, t_mine, pts3d, pts2d, scene.K)

    ok, rvec, tvec = cv2.solvePnP(
        pts3d.reshape(-1, 1, 3).astype(np.float64),
        pts2d.reshape(-1, 1, 2).astype(np.float64),
        scene.K.astype(np.float64),
        distCoeffs=np.zeros(4),
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    assert ok
    r_cv, _ = cv2.Rodrigues(rvec)
    assert _angle_error_deg(r_mine, r_cv) < 0.5
    assert np.linalg.norm(t_mine - tvec.ravel()) < 1e-2
