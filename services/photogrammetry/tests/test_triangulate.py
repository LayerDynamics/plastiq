"""Tests for app/core/triangulate.py — two-view DLT triangulation + gates (P3.3, strict TDD).

The correctness gate is exact recovery on the synthetic ground-truth scene: a wide-baseline pair's
noise-free correspondences (imported from ``tests/synthetic.py`` — never modified here) must
triangulate back to the landmarks that produced them, to < 1e-8. The three quality gates are pinned
independently: a point placed behind a camera fails ``cheirality_mask``; a near-degenerate tiny-
baseline pair (two ``look_at`` views a couple of cm apart) falls below the 1.5° ``parallax_mask``
threshold while the wide fixture pair clears it; a several-pixel-corrupted correspondence is flagged
by ``reprojection_mask``. ``triangulate_gated`` must equal the AND of the three, and results are
deterministic across runs (SPEC-13 NFR-1 — a fixed-size CPU eigh has no RNG).

``cv2`` is used ONLY here as a parity oracle (SPEC-13 D-1 — never imported by ``app/``).
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core import triangulate as tri
from tests.synthetic import look_at, make_synthetic_scene

# Widest-baseline pair on the 8-view arc (views 0 and 7, ±~69°) — the most demanding, best-
# conditioned two-view geometry the fixture offers.
_PAIR = (0, 7)


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _proj(scene, view: int) -> np.ndarray:
    """Camera projection matrix ``P = K @ [R|t]`` (3x4) for a fixture view."""
    return scene.K @ scene.poses_w2c[view]


def _covisible(scene, a: int, b: int):
    """``(pts1, pts2, X_true)`` for every landmark seen in BOTH views a and b (visibility oracle)."""
    pts1, pts2, xs = [], [], []
    for m, obs in enumerate(scene.visibility):
        seen = {view: (u, v) for (view, u, v) in obs}
        if a in seen and b in seen:
            pts1.append(seen[a])
            pts2.append(seen[b])
            xs.append(scene.points3d[m])
    return (
        np.array(pts1, dtype=np.float64),
        np.array(pts2, dtype=np.float64),
        np.array(xs, dtype=np.float64),
    )


# --- exact recovery on the synthetic ground truth ------------------------------------------------

def test_triangulate_recovers_noise_free_wide_pair():
    scene = _scene()
    pts1, pts2, x_true = _covisible(scene, *_PAIR)
    assert pts1.shape[0] >= 8

    p1, p2 = _proj(scene, _PAIR[0]), _proj(scene, _PAIR[1])
    x = tri.triangulate(p1, p2, pts1, pts2)

    assert x.shape == (pts1.shape[0], 3)
    # Noise-free DLT recovers the exact landmarks (plan bar: < 1e-8).
    assert np.abs(x - x_true).max() < 1e-8


def test_triangulate_shape_and_determinism():
    scene = _scene()
    pts1, pts2, _ = _covisible(scene, *_PAIR)
    p1, p2 = _proj(scene, _PAIR[0]), _proj(scene, _PAIR[1])

    x1 = tri.triangulate(p1, p2, pts1, pts2)
    x2 = tri.triangulate(p1, p2, pts1, pts2)
    assert x1.shape == (pts1.shape[0], 3)
    # No RNG in a fixed-size CPU eigh — identical runs are bitwise-identical (NFR-1).
    assert np.array_equal(x1, x2)


# --- cheirality gate -----------------------------------------------------------------------------

def test_cheirality_rejects_point_behind_camera():
    scene = _scene()
    p1, p2 = _proj(scene, _PAIR[0]), _proj(scene, _PAIR[1])

    # A genuine co-visible landmark is in front of both cameras by construction.
    _, _, x_true = _covisible(scene, *_PAIR)
    x_front = x_true[0]

    # Build a point 2 units *behind* camera 0 along its forward axis (row 2 of R is world-forward;
    # centre C0 = -Rᵀ t). Its depth in camera 0 is negative ⇒ must fail cheirality.
    pose0 = scene.poses_w2c[_PAIR[0]]
    r0, t0 = pose0[:, :3], pose0[:, 3]
    c0 = -r0.T @ t0
    forward0 = r0[2, :]
    x_behind = c0 - 2.0 * forward0

    x = np.stack([x_front, x_behind], axis=0)
    mask = tri.cheirality_mask(p1, p2, x)
    assert mask.dtype == bool
    assert mask.shape == (2,)
    assert bool(mask[0]) is True   # in front of both
    assert bool(mask[1]) is False  # behind camera 0


# --- parallax gate -------------------------------------------------------------------------------

def test_parallax_rejects_tiny_baseline_passes_wide():
    scene = _scene()

    # Two nearly-coincident views (2 cm apart) looking at the same distant target ⇒ triangulation
    # angle far below the 1.5° gate.
    target = np.array([0.0, 0.4, 0.0])
    pose_a = look_at((0.0, 2.6, -4.5), target)
    pose_b = look_at((0.02, 2.6, -4.5), target)
    pa, pb = scene.K @ pose_a, scene.K @ pose_b
    x_near = target[None, :]  # ~5 units away; baseline 2 cm ⇒ angle ~0.2°
    tiny = tri.parallax_mask(pa, pb, x_near, min_deg=1.5)
    assert tiny.dtype == bool
    assert bool(tiny[0]) is False

    # The wide fixture pair (±~69°) clears the gate for all its co-visible structure.
    p1, p2 = _proj(scene, _PAIR[0]), _proj(scene, _PAIR[1])
    _, _, x_true = _covisible(scene, *_PAIR)
    wide = tri.parallax_mask(p1, p2, x_true, min_deg=1.5)
    assert wide.all()


# --- reprojection gate ---------------------------------------------------------------------------

def test_reprojection_flags_corrupted_correspondence():
    scene = _scene()
    pts1, pts2, _ = _covisible(scene, *_PAIR)
    p1, p2 = _proj(scene, _PAIR[0]), _proj(scene, _PAIR[1])
    x = tri.triangulate(p1, p2, pts1, pts2)

    # Clean correspondences reproject to sub-pixel error ⇒ all pass.
    clean = tri.reprojection_mask(p1, p2, pts1, pts2, x, max_px=4.0)
    assert clean.dtype == bool
    assert clean.all()

    # Corrupt the first view-1 observation by several pixels ⇒ only that one is flagged.
    pts1_bad = pts1.copy()
    pts1_bad[0] += np.array([6.0, 0.0])
    flagged = tri.reprojection_mask(p1, p2, pts1_bad, pts2, x, max_px=4.0)
    assert bool(flagged[0]) is False
    assert flagged[1:].all()


# --- gated convenience composes all three --------------------------------------------------------

def test_triangulate_gated_composes_all_three():
    scene = _scene()
    pts1, pts2, _ = _covisible(scene, *_PAIR)
    p1, p2 = _proj(scene, _PAIR[0]), _proj(scene, _PAIR[1])

    x, valid = tri.triangulate_gated(p1, p2, pts1, pts2, max_px=4.0, min_deg=1.5)
    assert x.shape == (pts1.shape[0], 3)
    assert valid.dtype == bool

    expected = (
        tri.cheirality_mask(p1, p2, x)
        & tri.reprojection_mask(p1, p2, pts1, pts2, x, max_px=4.0)
        & tri.parallax_mask(p1, p2, x, min_deg=1.5)
    )
    assert np.array_equal(valid, expected)
    # The clean wide pair is fully valid.
    assert valid.all()


# --- OpenCV parity (oracle; cv2 is test-only) ----------------------------------------------------

def test_opencv_triangulatepoints_parity():
    cv2 = pytest.importorskip("cv2")
    scene = _scene()
    pts1, pts2, _ = _covisible(scene, *_PAIR)
    p1, p2 = _proj(scene, _PAIR[0]), _proj(scene, _PAIR[1])

    x_mine = tri.triangulate(p1, p2, pts1, pts2)

    # cv2.triangulatePoints wants 2xN inputs and returns 4xN homogeneous world points.
    xh = cv2.triangulatePoints(p1, p2, pts1.T.copy(), pts2.T.copy())
    x_cv = (xh[:3] / xh[3]).T

    assert np.allclose(x_mine, x_cv, atol=1e-6)
