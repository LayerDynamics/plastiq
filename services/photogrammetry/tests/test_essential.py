"""P2.3 — Nistér five-point essential-matrix solver + pose recovery (`app.core.epipolar`).

Verifies the minimal solver against the fixture's exact ground-truth relative pose (not just
self-consistency) and against the cv2 `findEssentialMat`/`recoverPose` oracle. The five-point solver
is the minimal case, so the exact-recovery test uses exactly 5 correspondences; pose recovery and the
cv2 parity use the full co-visible set.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core.epipolar import decompose_essential, find_essential, recover_pose
from tests.synthetic import make_synthetic_scene

_PAIRS = [(0, 5), (1, 6), (2, 7), (0, 4)]  # wide-baseline pairs with enough co-visible landmarks


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _skew(t):
    return np.array([[0.0, -t[2], t[1]], [t[2], 0.0, -t[0]], [-t[1], t[0], 0.0]])


def _gt_relative(scene, a, b):
    """Ground-truth relative pose a→b and essential matrix from the fixture's exact poses."""
    Ra, ta = scene.poses_w2c[a][:, :3], scene.poses_w2c[a][:, 3]
    Rb, tb = scene.poses_w2c[b][:, :3], scene.poses_w2c[b][:, 3]
    R_rel = Rb @ Ra.T
    t_rel = tb - R_rel @ ta
    E_gt = _skew(t_rel) @ R_rel
    return R_rel, t_rel, E_gt


def _covisible(scene, a, b):
    """Co-visible landmark indices + their (pts_a, pts_b) pixel correspondences for views a, b."""
    idx, pa, pb = [], [], []
    for m in range(scene.points3d.shape[0]):
        obs = {v: (u, w) for (v, u, w) in scene.visibility[m]}
        if a in obs and b in obs:
            idx.append(m)
            pa.append(obs[a])
            pb.append(obs[b])
    return np.array(idx), np.array(pa, dtype=np.float64), np.array(pb, dtype=np.float64)


def _correspondences(scene, a, b):
    _, pa, pb = _covisible(scene, a, b)
    return pa, pb


def _minimal5(scene, a, b):
    """A NON-COPLANAR 5-correspondence subset (the five-point algorithm degenerates on coplanar
    points — the fixture's plane-grid landmarks all lie on y=0). Mixes box (y>0.1) and plane points
    so the minimal set is in general position."""
    idx, pa, pb = _covisible(scene, a, b)
    ys = scene.points3d[idx][:, 1]
    box = np.where(ys > 0.1)[0]
    plane = np.where(ys <= 0.1)[0]
    pick = list(box[:3]) + list(plane[:5 - min(3, len(box))])
    pick = pick[:5]
    return pa[pick], pb[pick]


def _prop_diff(A, B):
    """Scale+sign-invariant difference between two matrices (E is defined up to scale and sign)."""
    A = A / (np.linalg.norm(A) + 1e-15)
    B = B / (np.linalg.norm(B) + 1e-15)
    return float(min(np.linalg.norm(A - B), np.linalg.norm(A + B)))


def _rot_angle_deg(R1, R2):
    c = (np.trace(R1.T @ R2) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def _dir_angle_deg(t1, t2):
    t1 = np.asarray(t1, dtype=np.float64).ravel()  # cv2.recoverPose returns t as a (3, 1) column
    t2 = np.asarray(t2, dtype=np.float64).ravel()
    t1 = t1 / (np.linalg.norm(t1) + 1e-15)
    t2 = t2 / (np.linalg.norm(t2) + 1e-15)
    return float(np.degrees(np.arccos(np.clip(abs(t1 @ t2), -1.0, 1.0))))


@pytest.mark.parametrize("pair", _PAIRS)
def test_find_essential_recovers_ground_truth_candidate(pair):
    """The five-point solver produces the exact ground-truth E among its ≤10 candidates (minimal
    5-correspondence case, noise-free)."""
    scene = _scene()
    a, b = pair
    pa, pb = _correspondences(scene, a, b)
    assert pa.shape[0] >= 5
    _, _, E_gt = _gt_relative(scene, a, b)
    p5a, p5b = _minimal5(scene, a, b)
    cands = find_essential(p5a, p5b, scene.K, scene.K)
    diffs = [_prop_diff(E, E_gt) for E in cands]
    assert min(diffs) < 1e-6, f"best candidate diff {min(diffs):.2e} (of {len(cands)} candidates)"


@pytest.mark.parametrize("pair", _PAIRS)
def test_recover_pose_matches_ground_truth(pair):
    """Cheirality selects the correct (R, t) — rotation < 0.1°, translation direction < 0.5°."""
    scene = _scene()
    a, b = pair
    pa, pb = _correspondences(scene, a, b)
    R_gt, t_gt, _ = _gt_relative(scene, a, b)
    p5a, p5b = _minimal5(scene, a, b)
    cands = find_essential(p5a, p5b, scene.K, scene.K)
    R, t, mask = recover_pose(cands, pa, pb, scene.K, scene.K)
    assert _rot_angle_deg(R, R_gt) < 0.1
    assert _dir_angle_deg(t, t_gt) < 0.5
    assert mask.sum() >= 5  # most correspondences are cheirality-valid for the winner


def test_find_essential_requires_five_points():
    scene = _scene()
    pa, pb = _correspondences(scene, *_PAIRS[0])
    with pytest.raises(ValueError):
        find_essential(pa[:4], pb[:4], scene.K, scene.K)


def test_decompose_essential_returns_proper_rotations():
    scene = _scene()
    _, _, E_gt = _gt_relative(scene, *_PAIRS[0])
    R1, R2, t = decompose_essential(E_gt)
    for R in (R1, R2):
        assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)
        assert np.isclose(np.linalg.det(R), 1.0, atol=1e-9)
    assert np.isclose(np.linalg.norm(t), 1.0, atol=1e-6)


def test_opencv_findessential_recoverpose_parity():
    """cv2.findEssentialMat + recoverPose recover the same relative pose as ours (noisy pair)."""
    cv2 = pytest.importorskip("cv2")
    scene = _scene()
    a, b = _PAIRS[0]
    pa, pb = _correspondences(scene, a, b)
    R_gt, t_gt, _ = _gt_relative(scene, a, b)

    p5a, p5b = _minimal5(scene, a, b)
    cands = find_essential(p5a, p5b, scene.K, scene.K)
    R_ours, t_ours, _ = recover_pose(cands, pa, pb, scene.K, scene.K)

    E_cv, _ = cv2.findEssentialMat(pa, pb, scene.K, method=cv2.RANSAC, prob=0.999, threshold=1.0)
    _, R_cv, t_cv, _ = cv2.recoverPose(E_cv, pa, pb, scene.K)

    # Both must agree with ground truth (and hence each other) to ~1°.
    assert _rot_angle_deg(R_ours, R_gt) < 1.0
    assert _rot_angle_deg(R_cv, R_gt) < 1.0
    assert _rot_angle_deg(R_ours, R_cv) < 1.5
    assert _dir_angle_deg(t_ours, t_cv) < 2.0
