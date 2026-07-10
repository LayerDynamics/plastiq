"""Tests for app/core/ba.py — the bundle-adjustment optimization loop (P4.2).

P4.1 built the residual model, parameterization, and analytic Jacobian sparsity (proven exact in
``tests/test_ba.py``). Here we drive ``run_bundle_adjustment`` — the ``scipy.optimize.least_squares``
``trf`` loop that consumes those pieces — and prove genuine recoveries (not smoke):

* a perturbed start (poses, points, focal) converges to sub-pixel reprojection and recovers the
  gauge-invariant intrinsics (focal to ~1e-3 relative, not merely inside the starting perturbation);
* ``fix_intrinsics=True`` holds the 7 intrinsics byte-for-byte while still converging;
* Huber loss keeps the *inlier* reprojection sub-pixel under gross outliers where a linear loss is
  dragged off;
* ``free_cams`` (local BA) leaves every fixed camera's parameters byte-for-byte unchanged;
* two identical runs are bit-identical (deterministic ``trf``).

The ground-truth problem is built from the synthetic scene exactly as ``tests/test_ba.py`` does
(shared ``[f, cx, cy, k1, k2, p1, p2]`` intrinsics with zero distortion, angle-axis + translation
per camera, ``(cam_idx, pt_idx, u, v)`` observations).
"""

from __future__ import annotations

import numpy as np

from app.core import ba
from tests.synthetic import make_synthetic_scene


def _scene_problem(n_views=6, seed=0):
    """Build a (intrinsics, cam_params, points, observations) ground-truth BA problem from the scene.

    Copied from ``tests/test_ba.py`` (the P4.1 oracle) so this suite stays self-contained: intrinsics
    ``[f, cx, cy, 0, 0, 0, 0]`` (zero distortion), per-camera ``[rvec, tvec]`` with
    ``rvec = inverse_rodrigues(R)``, and ``(view, landmark, u, v)`` observation rows.
    """
    s = make_synthetic_scene(n_views=n_views, height=96, width=96, seed=seed)
    f = s.K[0, 0]
    cx, cy = s.K[0, 2], s.K[1, 2]
    intrinsics = np.array([f, cx, cy, 0.0, 0.0, 0.0, 0.0])
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


def _mean_reprojection(x, observations, n_cams, n_pts, rows=None):
    """Mean per-observation Euclidean pixel error for ``x`` (optionally over a subset of ``rows``)."""
    r = ba.residuals(x, observations, n_cams, n_pts)
    du = r[0::2]
    dv = r[1::2]
    per_obs = np.sqrt(du * du + dv * dv)
    if rows is not None:
        per_obs = per_obs[rows]
    return float(np.mean(per_obs))


def _cam_slice(c):
    """Index slice of camera ``c``'s 6 parameters inside the packed vector."""
    base = 7 + 6 * c
    return slice(base, base + 6)


def test_converges_from_perturbed_start():
    intr, cams, pts, obs, _s = _scene_problem()
    n_cams, n_pts = cams.shape[0], pts.shape[0]
    f_true = intr[0]

    rng = np.random.default_rng(1234)
    cams_p = cams.copy()
    for i in range(n_cams):
        axis = rng.standard_normal(3)
        axis /= np.linalg.norm(axis)
        cams_p[i, :3] += np.deg2rad(1.0) * axis          # ~1.0 deg rotation perturbation
        cams_p[i, 3:] += 0.04 * rng.standard_normal(3)   # small translation perturbation
    pts_p = pts * (1.0 + 0.02 * rng.standard_normal(pts.shape))  # ~2% point perturbation
    intr_p = intr.copy()
    intr_p[0] = f_true * 1.03                             # ~3% focal perturbation
    x0 = ba.pack(intr_p, cams_p, pts_p)

    start_reproj = _mean_reprojection(x0, obs, n_cams, n_pts)
    # The start is genuinely off — several times the sub-pixel pass bar — so a green result proves a
    # real recovery, not that BA started at the optimum (plan gate #4: exact-recovery, not smoke).
    assert start_reproj > 1.5

    x_opt, info = ba.run_bundle_adjustment(x0, obs, n_cams, n_pts)
    end_reproj = _mean_reprojection(x_opt, obs, n_cams, n_pts)

    assert info["success"]
    assert end_reproj < 0.5      # in practice BA drives this to ~machine zero on the noise-free scene
    assert info["mean_reprojection_error"] == end_reproj
    # Convergence must come from the ftol/xtol/gtol tolerances, not from grinding to max_nfev — the
    # missing-tolerances regression made real-photo BA run tens of thousands of iterations (the P7
    # runtime pathology). A healthy solve on this scene needs only a handful.
    assert info["n_iterations"] < 200

    intr_opt, _c, _p = ba.unpack(x_opt, n_cams, n_pts)
    # Focal is gauge-invariant in a noise-free problem, so it recovers near-exactly (~1e-4 relative) —
    # far tighter than the 3% starting error. A "within 3%" bound would pass even if BA never moved
    # the focal at all; the 5e-3 bound is what makes this a genuine recovery assertion.
    assert abs(intr_opt[0] - f_true) / f_true < 5e-3
    assert abs(intr_opt[1] - intr[1]) < 0.5   # cx recovered
    assert abs(intr_opt[2] - intr[2]) < 0.5   # cy recovered


def test_fix_intrinsics_holds_intrinsics_and_converges():
    intr, cams, pts, obs, _s = _scene_problem()
    n_cams, n_pts = cams.shape[0], pts.shape[0]

    rng = np.random.default_rng(7)
    cams_p = cams.copy()
    for i in range(n_cams):
        axis = rng.standard_normal(3)
        axis /= np.linalg.norm(axis)
        cams_p[i, :3] += np.deg2rad(0.5) * axis
        cams_p[i, 3:] += 0.02 * rng.standard_normal(3)
    pts_p = pts * (1.0 + 0.01 * rng.standard_normal(pts.shape))
    x0 = ba.pack(intr, cams_p, pts_p)  # intrinsics start at truth

    x_opt, info = ba.run_bundle_adjustment(x0, obs, n_cams, n_pts, fix_intrinsics=True)
    end_reproj = _mean_reprojection(x_opt, obs, n_cams, n_pts)

    assert end_reproj < 0.5
    # Intrinsics held: the 7 intrinsic entries are byte-for-byte unchanged.
    assert np.array_equal(x_opt[:7], x0[:7])


def test_huber_beats_linear_under_gross_outliers():
    intr, cams, pts, obs, _s = _scene_problem()
    n_cams, n_pts = cams.shape[0], pts.shape[0]

    rng = np.random.default_rng(99)
    cams_p = cams.copy()
    for i in range(n_cams):
        axis = rng.standard_normal(3)
        axis /= np.linalg.norm(axis)
        cams_p[i, :3] += np.deg2rad(0.3) * axis
        cams_p[i, 3:] += 0.01 * rng.standard_normal(3)
    x0 = ba.pack(intr, cams_p, pts.copy())

    # Corrupt ~5% of observations with a large pixel offset (gross outliers).
    n_obs = obs.shape[0]
    n_bad = max(1, int(round(0.05 * n_obs)))
    bad_rows = rng.choice(n_obs, size=n_bad, replace=False)
    obs_corrupt = obs.copy()
    obs_corrupt[bad_rows, 2] += 30.0
    obs_corrupt[bad_rows, 3] -= 30.0
    inlier_rows = np.setdiff1d(np.arange(n_obs), bad_rows)

    x_huber, _ih = ba.run_bundle_adjustment(x0, obs_corrupt, n_cams, n_pts, loss="huber", f_scale=1.0)
    x_linear, _il = ba.run_bundle_adjustment(x0, obs_corrupt, n_cams, n_pts, loss="linear")

    # Compare on the INLIER rows only (Huber deliberately leaves the corrupted rows large).
    inlier_reproj_huber = _mean_reprojection(x_huber, obs_corrupt, n_cams, n_pts, rows=inlier_rows)
    inlier_reproj_linear = _mean_reprojection(x_linear, obs_corrupt, n_cams, n_pts, rows=inlier_rows)

    assert inlier_reproj_huber < 1.0                      # inliers still converge under Huber
    assert inlier_reproj_huber < inlier_reproj_linear     # linear is dragged off by the outliers


def test_local_ba_leaves_fixed_cameras_untouched():
    intr, cams, pts, obs, _s = _scene_problem()
    n_cams, n_pts = cams.shape[0], pts.shape[0]
    free_cams = [n_cams - 2, n_cams - 1]  # only the two "newest" views are free

    rng = np.random.default_rng(2024)
    cams_p = cams.copy()
    for c in free_cams:  # perturb only the free cameras
        axis = rng.standard_normal(3)
        axis /= np.linalg.norm(axis)
        cams_p[c, :3] += np.deg2rad(0.5) * axis
        cams_p[c, 3:] += 0.02 * rng.standard_normal(3)
    pts_p = pts * (1.0 + 0.005 * rng.standard_normal(pts.shape))
    x0 = ba.pack(intr, cams_p, pts_p)

    x_opt, _info = ba.run_bundle_adjustment(x0, obs, n_cams, n_pts, free_cams=free_cams)

    fixed_cams = [c for c in range(n_cams) if c not in free_cams]
    for c in fixed_cams:
        # Fixed cameras must be byte-for-byte unchanged.
        assert np.array_equal(x_opt[_cam_slice(c)], x0[_cam_slice(c)])
    # The free cameras actually moved (BA did work on them).
    moved = any(not np.array_equal(x_opt[_cam_slice(c)], x0[_cam_slice(c)]) for c in free_cams)
    assert moved


def test_deterministic_two_runs_identical():
    intr, cams, pts, obs, _s = _scene_problem()
    n_cams, n_pts = cams.shape[0], pts.shape[0]

    rng = np.random.default_rng(5)
    cams_p = cams.copy()
    for i in range(n_cams):
        cams_p[i, :3] += 0.003 * rng.standard_normal(3)
        cams_p[i, 3:] += 0.01 * rng.standard_normal(3)
    x0 = ba.pack(intr, cams_p, pts.copy())

    x1, info1 = ba.run_bundle_adjustment(x0, obs, n_cams, n_pts)
    x2, info2 = ba.run_bundle_adjustment(x0, obs, n_cams, n_pts)

    assert np.array_equal(x1, x2)
    assert info1 == info2
