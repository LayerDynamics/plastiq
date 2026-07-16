"""Oracle tests for the MLX plane-sweep MVS depth/normal estimator (P9.1, SPEC-13 §5.5).

The synthetic scene (``tests/synthetic.py``) carries an exact per-pixel camera-Z depth map per view,
so these are genuine recovery asserts (NFR-2), not smoke: a middle reference view is swept against its
baseline-selected neighbours and the recovered depth is compared to the ground-truth depth oracle, and
the recovered normals to normals derived the same way from the ground-truth depth. The MLX path is
exercised (``importorskip`` on Apple-Silicon Metal); OpenCV is not used here (no oracle needed — the
fixture *is* the oracle).
"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("mlx.core")

from app.mvs.plane_sweep import depth_to_normals, plane_sweep  # noqa: E402
from tests.synthetic import make_synthetic_scene  # noqa: E402


def _gt_depth_range(depth: np.ndarray) -> tuple[float, float]:
    finite = depth[np.isfinite(depth)]
    return float(finite.min()), float(finite.max())


def _textured_mask(depth_gt: np.ndarray, border: int) -> np.ndarray:
    """Finite-GT (non-background) pixels away from the image border where a full window fits."""
    m = np.isfinite(depth_gt)
    m[:border, :] = False
    m[-border:, :] = False
    m[:, :border] = False
    m[:, -border:] = False
    return m


@pytest.mark.parametrize("ref_idx", [3, 4])
def test_plane_sweep_depth_within_one_percent(ref_idx):
    """>= 70% of textured (finite-GT) pixels recover depth within 1% of the ground truth."""
    s = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    dmin, dmax = _gt_depth_range(s.depths[ref_idx])

    depth, normals, valid = plane_sweep(
        ref_idx, s.images, s.poses_w2c, s.K, depth_range=(dmin, dmax)
    )

    assert depth.shape == (96, 96)
    assert normals.shape == (96, 96, 3)
    assert valid.shape == (96, 96)
    assert depth.dtype == np.float32
    assert normals.dtype == np.float32
    assert valid.dtype == np.bool_

    gt = s.depths[ref_idx]
    mask = _textured_mask(gt, border=3)
    rel_err = np.abs(depth[mask] - gt[mask]) / gt[mask]
    within = np.isfinite(rel_err) & (rel_err < 0.01)
    frac = float(within.mean())
    assert frac >= 0.70, f"only {frac:.1%} of textured pixels within 1% depth (ref {ref_idx})"


def test_plane_sweep_normals_agree_with_ground_truth():
    """Median recovered-normal . ground-truth-normal > 0.9 over textured pixels."""
    s = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    ref_idx = 4
    dmin, dmax = _gt_depth_range(s.depths[ref_idx])

    depth, normals, valid = plane_sweep(
        ref_idx, s.images, s.poses_w2c, s.K, depth_range=(dmin, dmax)
    )

    gt_normals = depth_to_normals(s.depths[ref_idx].astype(np.float32), s.K)
    mask = _textured_mask(s.depths[ref_idx], border=3)
    mask &= np.isfinite(gt_normals).all(axis=2)
    mask &= np.isfinite(normals).all(axis=2)

    dots = np.sum(normals[mask] * gt_normals[mask], axis=1)
    assert np.median(dots) > 0.9, f"median normal dot {np.median(dots):.3f}"


def test_plane_sweep_is_deterministic():
    """Two runs on identical input return identical depth/normals/valid (no RNG, D-10).

    ``depth``/``normals`` carry a **by-design** NaN pattern at background / unconstrained pixels (the
    function's contract — see ``test_plane_sweep_valid_marks_confident_pixels``), so determinism is
    asserted with ``equal_nan=True``: it requires both the finite values AND the NaN pattern to match
    exactly across runs (the finite values are bitwise-identical; ``array_equal`` without ``equal_nan``
    would false-negative purely because ``NaN != NaN``). ``valid`` is boolean (no NaN)."""
    s = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    ref_idx = 4
    dmin, dmax = _gt_depth_range(s.depths[ref_idx])

    d1, n1, v1 = plane_sweep(ref_idx, s.images, s.poses_w2c, s.K, depth_range=(dmin, dmax))
    d2, n2, v2 = plane_sweep(ref_idx, s.images, s.poses_w2c, s.K, depth_range=(dmin, dmax))

    assert np.array_equal(d1, d2, equal_nan=True)
    assert np.array_equal(n1, n2, equal_nan=True)
    assert np.array_equal(v1, v2)


def test_depth_to_normals_fronto_parallel_plane():
    """A hand-built fronto-parallel depth plane has normals pointing straight at the camera (-z)."""
    h = w = 20
    fx = fy = 30.0
    K = np.array([[fx, 0.0, w / 2.0], [0.0, fy, h / 2.0], [0.0, 0.0, 1.0]])
    depth = np.full((h, w), 5.0, dtype=np.float32)  # constant Z ⇒ a plane facing the camera

    normals = depth_to_normals(depth, K)
    interior = normals[2:-2, 2:-2]
    # a fronto-parallel plane's normal is (0, 0, -1) in the +z-forward camera frame (toward camera)
    assert np.allclose(interior[..., 0], 0.0, atol=1e-5)
    assert np.allclose(interior[..., 1], 0.0, atol=1e-5)
    assert np.allclose(interior[..., 2], -1.0, atol=1e-5)


def test_plane_sweep_valid_marks_confident_pixels():
    """The valid mask is a subset of finite-depth pixels and covers most of the textured scene."""
    s = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    ref_idx = 4
    dmin, dmax = _gt_depth_range(s.depths[ref_idx])

    depth, _normals, valid = plane_sweep(
        ref_idx, s.images, s.poses_w2c, s.K, depth_range=(dmin, dmax)
    )
    # every valid pixel has a finite depth
    assert np.all(np.isfinite(depth[valid]))
    # valid covers a real fraction of the textured scene (not empty, not everything)
    textured = _textured_mask(s.depths[ref_idx], border=3)
    coverage = float(valid[textured].mean())
    assert coverage > 0.5, f"valid coverage over textured pixels only {coverage:.1%}"
