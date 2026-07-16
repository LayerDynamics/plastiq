"""Tests for app/core/epipolar.py — normalized 8-point fundamental + Sampson (P2.2, strict TDD).

The strict correctness gate is exact recovery on the synthetic ground-truth scene: a wide-baseline
pair's noise-free correspondences (imported from ``tests/synthetic.py`` — never modified here) must
yield an F whose algebraic epipolar residual ``x2ᵀ F x1`` and Sampson distance both vanish. Two more
checks pin the contract: the Sampson formula matches an independent inline numpy re-derivation on
random data, and OpenCV's ``findFundamentalMat(FM_8POINT)`` produces an equivalent F (compared by
held-out epipolar residuals + scale/sign-invariant proportionality — F is only defined up to scale).

``cv2`` is used ONLY here as a parity oracle (SPEC-13 D-1 — never imported by ``app/``).
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core import epipolar
from tests.synthetic import make_synthetic_scene

# Widest-baseline pair on the 8-view arc (views 0 and 7, ±~69°); 26 co-visible landmarks — the most
# demanding two-view geometry the fixture offers, and comfortably ≥ 8 for the 8-point DLT.
_PAIR = (0, 7)


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _correspondences(scene, a: int, b: int):
    """Build ``(pts1, pts2)`` (N, 2) from the visibility oracle for the co-visible landmarks of a,b."""
    pts1, pts2 = [], []
    for obs in scene.visibility:
        seen = {view: (u, v) for (view, u, v) in obs}
        if a in seen and b in seen:
            pts1.append(seen[a])
            pts2.append(seen[b])
    return np.array(pts1, dtype=np.float64), np.array(pts2, dtype=np.float64)


def _homog(pts):
    return np.hstack([pts, np.ones((pts.shape[0], 1))])


def _ground_truth_fundamental(scene, a: int, b: int):
    """The exact F for pair (a, b) from the fixture's known poses + K.

    ``F = K⁻ᵀ [t_rel]ₓ R_rel K⁻¹`` with the relative pose ``R_rel = R_b R_aᵀ``,
    ``t_rel = t_b − R_rel t_a`` — matching the ``pts2ᵀ F pts1 = 0`` (view b on the left) convention.
    Unit-Frobenius scaled so it is comparable to ``find_fundamental``'s output up to sign.
    """
    K = scene.K
    Ra, ta = scene.poses_w2c[a][:, :3], scene.poses_w2c[a][:, 3]
    Rb, tb = scene.poses_w2c[b][:, :3], scene.poses_w2c[b][:, 3]
    R_rel = Rb @ Ra.T
    t_rel = tb - R_rel @ ta
    tx = np.array(
        [[0.0, -t_rel[2], t_rel[1]], [t_rel[2], 0.0, -t_rel[0]], [-t_rel[1], t_rel[0], 0.0]]
    )
    E = tx @ R_rel
    Kinv = np.linalg.inv(K)
    F = Kinv.T @ E @ Kinv
    return F / np.linalg.norm(F)


def _proportional_diff(A, B):
    """Max abs difference of two matrices as unit vectors, sign-aligned (F is defined up to scale)."""
    a = A.ravel() / np.linalg.norm(A)
    b = B.ravel() / np.linalg.norm(B)
    if np.dot(a, b) < 0:
        b = -b
    return np.abs(a - b).max()


# --- Hartley normalization (the shared helper P2.3 reuses) ---------------------------------------

def test_normalize_points_2d_properties():
    rng = np.random.default_rng(0)
    pts = rng.uniform(-500.0, 500.0, size=(40, 2))
    pts_norm, T = epipolar.normalize_points_2d(pts)

    assert pts_norm.shape == (40, 2)
    assert T.shape == (3, 3)
    # Centroid at the origin, mean distance to origin sqrt(2).
    assert np.allclose(pts_norm.mean(axis=0), 0.0, atol=1e-9)
    assert abs(np.linalg.norm(pts_norm, axis=1).mean() - np.sqrt(2.0)) < 1e-9
    # T maps homogeneous input points onto the normalized points.
    mapped = (_homog(pts) @ T.T)[:, :2]
    assert np.allclose(mapped, pts_norm, atol=1e-9)


# --- exact recovery on the synthetic ground truth ------------------------------------------------

def test_fundamental_recovers_noise_free_pair():
    scene = _scene()
    pts1, pts2 = _correspondences(scene, *_PAIR)
    assert pts1.shape[0] >= 8

    F = epipolar.find_fundamental(pts1, pts2)
    assert F.shape == (3, 3)
    # Rank-2 constraint enforced (smallest singular value driven to zero).
    sv = np.linalg.svd(F, compute_uv=False)
    assert sv[2] < 1e-9 * sv[0]

    # Genuine recovery — the estimate equals the F derived from the fixture's true poses+K, not just
    # some self-consistent impostor (the co-visible set is non-coplanar: 18 box + 8 plane points).
    F_gt = _ground_truth_fundamental(scene, *_PAIR)
    assert _proportional_diff(F, F_gt) < 1e-6

    # Algebraic epipolar residual x2ᵀ F x1 ≈ 0 for every correspondence (plan bar: < 1e-9).
    alg = np.einsum("ni,ij,nj->n", _homog(pts2), F, _homog(pts1))
    assert np.abs(alg).max() < 1e-9

    # Geometric Sampson error ≈ 0.
    samp = epipolar.sampson_distance(F, pts1, pts2)
    assert samp.shape == (pts1.shape[0],)
    assert samp.max() < 1e-6


# --- Sampson formula parity against an independent re-derivation ----------------------------------

def test_sampson_matches_independent_formula():
    rng = np.random.default_rng(0)
    F = rng.standard_normal((3, 3))
    pts1 = rng.uniform(-200.0, 200.0, size=(50, 2))
    pts2 = rng.uniform(-200.0, 200.0, size=(50, 2))

    mine = epipolar.sampson_distance(F, pts1, pts2)

    # Independent first-order (Sampson) geometric error re-derivation, entry by entry.
    eps = 1e-8
    expected = np.empty(pts1.shape[0])
    for i in range(pts1.shape[0]):
        x1 = np.array([pts1[i, 0], pts1[i, 1], 1.0])
        x2 = np.array([pts2[i, 0], pts2[i, 1], 1.0])
        Fx1 = F @ x1
        Ftx2 = F.T @ x2
        num = float(x2 @ F @ x1) ** 2
        den = Fx1[0] ** 2 + Fx1[1] ** 2 + Ftx2[0] ** 2 + Ftx2[1] ** 2
        expected[i] = np.sqrt(num / (den + eps))

    assert np.allclose(mine, expected, atol=1e-12, rtol=1e-9)


# --- OpenCV parity (oracle; cv2 is test-only) ----------------------------------------------------

def test_opencv_findfundamentalmat_parity():
    cv2 = pytest.importorskip("cv2")
    scene = _scene()
    pts1, pts2 = _correspondences(scene, *_PAIR)
    # Fit on a training subset, judge equivalence on the held-out subset (behaviour, not raw entries).
    split = 16
    train1, train2 = pts1[:split], pts2[:split]
    held1, held2 = pts1[split:], pts2[split:]

    F_mine = epipolar.find_fundamental(train1, train2)
    F_cv, _ = cv2.findFundamentalMat(train1, train2, cv2.FM_8POINT)

    # Both matrices explain the held-out correspondences (Sampson is scale-invariant), and agree.
    # Our f64 DLT is exact (< 1e-6 px); cv2's FM_8POINT runs at lower internal precision, so its
    # held-out residual sits at ~1e-6 px — still sub-micro-pixel agreement (oracle-tolerance, 1e-4).
    samp_mine = epipolar.sampson_distance(F_mine, held1, held2)
    samp_cv = epipolar.sampson_distance(F_cv, held1, held2)
    assert samp_mine.max() < 1e-6
    assert samp_cv.max() < 1e-4
    assert np.allclose(samp_mine, samp_cv, atol=1e-4)

    # Bonus: same matrix up to scale/sign (loose tol — the task steers to behaviour over entries).
    assert _proportional_diff(F_mine, F_cv) < 1e-3


# --- guards --------------------------------------------------------------------------------------

def test_find_fundamental_requires_eight_points():
    rng = np.random.default_rng(0)
    pts = rng.uniform(-1.0, 1.0, size=(7, 2))
    with pytest.raises(ValueError):
        epipolar.find_fundamental(pts, pts)
