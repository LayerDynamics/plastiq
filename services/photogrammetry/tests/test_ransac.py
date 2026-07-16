"""Tests for app/core/ransac.py — seeded MSAC robust estimation for E / F / PnP (P3.1, strict TDD).

The correctness bed is the synthetic ground-truth scene (``tests/synthetic.py`` — never modified
here): co-visible correspondences of a wide-baseline pair (fundamental/essential) or a view's exact
3D↔2D correspondences (PnP) are the *planted inliers*, then a batch of **gross outliers** (random
wrong matches, each verified against the ground-truth geometry so it truly violates the model by a
wide margin) is injected. The seeded MSAC driver must recover an inlier set that

* contains ≥ 95% of the planted inliers, and
* contains **zero** planted outliers,

and — for essential / PnP — a pose within ~1° of ground truth. Two runs with the same seed must give
byte-identical masks (D-10 determinism); different seeds are allowed to differ. A final, loose sanity
check compares the fundamental inlier count against ``cv2.findFundamentalMat(FM_RANSAC)``.

``cv2`` is used ONLY here as a parity oracle (SPEC-13 D-1 — never imported by ``app/``); all outlier
construction reuses the already-verified ``app.core.epipolar`` helpers, not cv2.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core import epipolar, ransac
from tests.synthetic import make_synthetic_scene, project_points

# Widest-baseline pair on the 8-view arc (views 0 and 7, ±~69°) — the most demanding two-view
# geometry the fixture offers; a central arc view for PnP (spans plane + box, so non-coplanar).
_PAIR = (0, 7)
_VIEW = 3


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _correspondences(scene, a: int, b: int):
    """``(pts1, pts2)`` (N, 2) built from the visibility oracle for the co-visible landmarks of a, b."""
    pts1, pts2 = [], []
    for obs in scene.visibility:
        seen = {view: (u, v) for (view, u, v) in obs}
        if a in seen and b in seen:
            pts1.append(seen[a])
            pts2.append(seen[b])
    return np.array(pts1, dtype=np.float64), np.array(pts2, dtype=np.float64)


def _view_correspondences(scene, view: int):
    """``(points3d (K, 3), points2d (K, 2))``: landmarks visible in ``view`` and their exact pixels."""
    idx = [m for m, obs in enumerate(scene.visibility) if any(v == view for (v, _, _) in obs)]
    pts3d = scene.points3d[idx]
    uv, _ = project_points(pts3d, scene.K, scene.poses_w2c[view])
    return pts3d, uv


def _ground_truth_fundamental(scene, a: int, b: int):
    """Exact F for pair (a, b) from the fixture's known poses + K (``pts2ᵀ F pts1 = 0`` convention)."""
    K = scene.K
    Ra, ta = scene.poses_w2c[a][:, :3], scene.poses_w2c[a][:, 3]
    Rb, tb = scene.poses_w2c[b][:, :3], scene.poses_w2c[b][:, 3]
    R_rel = Rb @ Ra.T
    t_rel = tb - R_rel @ ta
    tx = np.array([[0.0, -t_rel[2], t_rel[1]], [t_rel[2], 0.0, -t_rel[0]], [-t_rel[1], t_rel[0], 0.0]])
    E = tx @ R_rel
    Kinv = np.linalg.inv(K)
    F = Kinv.T @ E @ Kinv
    return F / np.linalg.norm(F)


def _relative_pose(scene, a: int, b: int):
    """Ground-truth relative pose (R_rel, unit t_rel) mapping camera-a coords → camera-b coords."""
    Ra, ta = scene.poses_w2c[a][:, :3], scene.poses_w2c[a][:, 3]
    Rb, tb = scene.poses_w2c[b][:, :3], scene.poses_w2c[b][:, 3]
    R_rel = Rb @ Ra.T
    t_rel = tb - R_rel @ ta
    return R_rel, t_rel / np.linalg.norm(t_rel)


def _angle_deg(r_est: np.ndarray, r_true: np.ndarray) -> float:
    """Geodesic rotation-angle error in degrees between two rotation matrices."""
    cos = (np.trace(r_est @ r_true.T) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def _dir_angle_deg(a: np.ndarray, b: np.ndarray) -> float:
    """Angle in degrees between two direction vectors."""
    ua = a / np.linalg.norm(a)
    ub = b / np.linalg.norm(b)
    return float(np.degrees(np.arccos(np.clip(abs(np.dot(ua, ub)), -1.0, 1.0))))


def _make_two_view_problem(scene, a, b, out_frac=0.30, seed=123):
    """Co-visible inliers + gross wrong-match outliers → ``(pts1, pts2, is_inlier)`` (shuffled)."""
    pts1, pts2 = _correspondences(scene, a, b)
    n_in = pts1.shape[0]
    n_out = int(round(out_frac * n_in / (1.0 - out_frac)))
    F_gt = _ground_truth_fundamental(scene, a, b)
    rng = np.random.Generator(np.random.PCG64(seed))
    out1, out2 = [], []
    tries = 0
    while len(out1) < n_out and tries < 100000:
        tries += 1
        i, j = int(rng.integers(n_in)), int(rng.integers(n_in))
        if i == j:
            continue
        p1, p2 = pts1[i], pts2[j]  # a real point in view a matched to the WRONG point in view b
        # keep only matches the ground-truth epipolar geometry rejects by a wide margin (truly gross)
        if epipolar.sampson_distance(F_gt, p1[None], p2[None])[0] > 5.0:
            out1.append(p1)
            out2.append(p2)
    out1 = np.array(out1, dtype=np.float64).reshape(-1, 2)
    out2 = np.array(out2, dtype=np.float64).reshape(-1, 2)
    all1 = np.vstack([pts1, out1])
    all2 = np.vstack([pts2, out2])
    is_inlier = np.concatenate([np.ones(n_in, bool), np.zeros(out1.shape[0], bool)])
    perm = rng.permutation(all1.shape[0])
    return all1[perm], all2[perm], is_inlier[perm]


def _make_pnp_problem(scene, view, out_frac=0.30, seed=321):
    """A view's exact 3D↔2D inliers + gross wrong-pixel outliers → ``(X, x, is_inlier)`` (shuffled)."""
    pts3d, pts2d = _view_correspondences(scene, view)
    n_in = pts3d.shape[0]
    n_out = int(round(out_frac * n_in / (1.0 - out_frac)))
    rng = np.random.Generator(np.random.PCG64(seed))
    idx = rng.integers(0, n_in, size=n_out)
    # a valid 3D landmark paired with a pixel far (≥ 15 px) from its true projection → gross outlier
    offsets = rng.uniform(-40.0, 40.0, size=(n_out, 2))
    offsets[np.linalg.norm(offsets, axis=1) < 15.0] += 20.0
    out3d = pts3d[idx]
    out2d = np.clip(pts2d[idx] + offsets, 0.5, 95.5)
    allX = np.vstack([pts3d, out3d])
    allx = np.vstack([pts2d, out2d])
    is_inlier = np.concatenate([np.ones(n_in, bool), np.zeros(n_out, bool)])
    perm = rng.permutation(allX.shape[0])
    return allX[perm], allx[perm], is_inlier[perm]


def _recall_and_false(mask, is_inlier):
    recall = (mask & is_inlier).sum() / max(1, is_inlier.sum())
    false_inliers = int((mask & ~is_inlier).sum())
    return recall, false_inliers


# --- fundamental --------------------------------------------------------------------------------

def test_ransac_fundamental_rejects_gross_outliers():
    scene = _scene()
    pts1, pts2, is_inlier = _make_two_view_problem(scene, *_PAIR)
    assert is_inlier.sum() >= 15 and (~is_inlier).sum() >= 5  # a real, contaminated problem

    F, mask = ransac.ransac_fundamental(pts1, pts2, seed=0, threshold=1.0)
    assert F.shape == (3, 3)
    assert mask.shape == (pts1.shape[0],) and mask.dtype == bool

    recall, false_inliers = _recall_and_false(mask, is_inlier)
    assert recall >= 0.95
    assert false_inliers == 0


# --- essential ----------------------------------------------------------------------------------

def test_ransac_essential_recovers_pose_and_rejects_outliers():
    scene = _scene()
    a, b = _PAIR
    pts1, pts2, is_inlier = _make_two_view_problem(scene, a, b)
    K = scene.K

    E, R, t, mask = ransac.ransac_essential(pts1, pts2, K, K, seed=0, threshold=1.0)
    assert E.shape == (3, 3) and R.shape == (3, 3) and t.shape == (3,)
    assert mask.shape == (pts1.shape[0],) and mask.dtype == bool

    R_rel, t_dir = _relative_pose(scene, a, b)
    assert _angle_deg(R, R_rel) < 1.0
    assert _dir_angle_deg(t, t_dir) < 1.0

    recall, false_inliers = _recall_and_false(mask, is_inlier)
    assert recall >= 0.95
    assert false_inliers == 0


# --- PnP ----------------------------------------------------------------------------------------

def test_ransac_pnp_recovers_pose_and_rejects_outliers():
    scene = _scene()
    X, x, is_inlier = _make_pnp_problem(scene, _VIEW)
    K = scene.K

    R, t, mask = ransac.ransac_pnp(X, x, K, seed=0, threshold=4.0)
    assert R.shape == (3, 3) and t.shape == (3,)
    assert mask.shape == (X.shape[0],) and mask.dtype == bool

    R_true = scene.poses_w2c[_VIEW][:, :3]
    t_true = scene.poses_w2c[_VIEW][:, 3]
    assert _angle_deg(R, R_true) < 1.0
    assert np.linalg.norm(t - t_true) < 1e-2

    recall, false_inliers = _recall_and_false(mask, is_inlier)
    assert recall >= 0.95
    assert false_inliers == 0


# --- determinism (D-10) -------------------------------------------------------------------------

def test_ransac_is_deterministic_by_seed():
    scene = _scene()
    pts1, pts2, _ = _make_two_view_problem(scene, *_PAIR)

    f1, m1 = ransac.ransac_fundamental(pts1, pts2, seed=7, threshold=1.0)
    f2, m2 = ransac.ransac_fundamental(pts1, pts2, seed=7, threshold=1.0)
    assert np.array_equal(m1, m2)
    assert np.allclose(f1, f2)

    # A different seed is *allowed* to differ; it must still solve the same problem correctly.
    _, m3 = ransac.ransac_fundamental(pts1, pts2, seed=99, threshold=1.0)
    assert m3.shape == m1.shape


def test_ransac_pnp_is_deterministic_by_seed():
    scene = _scene()
    X, x, _ = _make_pnp_problem(scene, _VIEW)
    K = scene.K

    r1, t1, m1 = ransac.ransac_pnp(X, x, K, seed=5, threshold=4.0)
    r2, t2, m2 = ransac.ransac_pnp(X, x, K, seed=5, threshold=4.0)
    assert np.array_equal(m1, m2)
    assert np.allclose(r1, r2) and np.allclose(t1, t2)


# --- loose OpenCV sanity (oracle) ---------------------------------------------------------------

def test_ransac_fundamental_inlier_count_near_opencv():
    cv2 = pytest.importorskip("cv2")
    scene = _scene()
    pts1, pts2, is_inlier = _make_two_view_problem(scene, *_PAIR)

    _, mask = ransac.ransac_fundamental(pts1, pts2, seed=0, threshold=1.0)
    ours = int(mask.sum())

    _, cv_mask = cv2.findFundamentalMat(pts1, pts2, cv2.FM_RANSAC, 1.0, 0.999)
    theirs = int(cv_mask.ravel().astype(bool).sum())

    # Both should land near the planted inlier count; compare loosely (RANSAC is stochastic).
    planted = int(is_inlier.sum())
    assert abs(ours - theirs) <= max(3, int(0.25 * planted))
    assert ours >= int(0.9 * planted)
