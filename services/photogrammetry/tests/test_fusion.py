"""Tests for app/mvs/fusion.py — multi-view geometric-consistency fusion (P9.2, strict TDD).

Fusion is the second dense stage (SPEC-13 §5.5): it consumes the plane-sweep stage's per-view depth
maps, world-frame normal maps and validity masks and emits the ``{points, normals}`` oriented cloud
that ``services/capture`` ``POST /capture`` ingests. This suite drives it from the synthetic scene's
EXACT ground-truth depths (``tests/synthetic.py``, never modified here) — NOT from the plane-sweep
module (a parallel agent owns it): the oracle depths ARE the perfect depth-map inputs, so any point
fusion emits must genuinely lie on the scene's plane/box surfaces, and any pixel we corrupt to a
wrong depth must be killed by the multi-view consistency check.

Correctness gates, all from the oracle:
  * fused points lie on the known plane+box surfaces (median point-to-surface < 1% of scene diameter);
  * planted bad-depth pixels (wrong depth in one view) are killed while consistent pixels survive;
  * the ``max_points`` voxel cap is enforced exactly;
  * the voxel downsample is deterministic (two runs bit-identical);
  * output normals are unit length and both arrays are ``(M, 3)``.

The input normal maps are WORLD-frame unit normals (the convention fusion's dot-product agreement
check compares across views, and the convention the plane-sweep stage emits). Pure numpy, no RNG.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from app.mvs.fusion import fuse, reproject, unproject
from tests.synthetic import make_synthetic_scene

# Known scene geometry — mirrors tests/synthetic.py's private constants (the finite ground plane at
# y=0 with half-extent 3.0, and the axis-aligned box). Re-declared here so the surface-distance
# oracle is explicit rather than reaching into synthetic.py's private state.
_PLANE_Y = 0.0
_PLANE_HALF = 3.0
_BOX_MIN = np.array([-0.7, 0.0, -0.7])
_BOX_MAX = np.array([0.7, 1.4, 0.7])


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _scene_diameter(scene) -> float:
    lo = scene.points3d.min(axis=0)
    hi = scene.points3d.max(axis=0)
    return float(np.linalg.norm(hi - lo))


def _unproject_grid(depth: np.ndarray, K: np.ndarray, pose: np.ndarray) -> np.ndarray:
    """(H, W) depth → (H, W, 3) world points, via the production ``unproject`` (public API reuse)."""
    h, w = depth.shape
    uu, vv = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    xw = unproject(depth.ravel(), uu.ravel(), vv.ravel(), K, pose)
    return xw.reshape(h, w, 3)


def _build_view_inputs(scene, corrupt=None):
    """Per-view (depth_maps, normal_maps, valid_masks) from the oracle depths.

    Normals: world-frame, from the unprojected depth-grid gradient cross-product, signed toward the
    camera (the plane-sweep stage's convention). Validity: interior pixels whose 4-neighbours are all
    finite and share the surface (small relative depth gap — depth discontinuities at the box edges,
    where the gradient normal is meaningless, are dropped). ``corrupt``: iterable of
    ``(view, v, u, factor)`` scaling that pixel's depth (planted bad depth).
    """
    n, h, w = scene.depths.shape
    depth_maps = scene.depths.astype(np.float64).copy()
    normal_maps = np.zeros((n, h, w, 3), dtype=np.float64)
    valid_masks = np.zeros((n, h, w), dtype=bool)
    for r in range(n):
        d = scene.depths[r]
        finite = np.isfinite(d)
        xw = _unproject_grid(d, scene.K, scene.poses_w2c[r])
        du = np.zeros_like(xw)
        dv = np.zeros_like(xw)
        du[:, 1:-1, :] = xw[:, 2:, :] - xw[:, :-2, :]
        dv[1:-1, :, :] = xw[2:, :, :] - xw[:-2, :, :]
        nrm = np.cross(du, dv)
        with np.errstate(invalid="ignore", divide="ignore"):
            nrm = nrm / np.linalg.norm(nrm, axis=-1, keepdims=True)
        cam_c = -scene.poses_w2c[r][:, :3].T @ scene.poses_w2c[r][:, 3]
        flip = np.sum(nrm * (cam_c[None, None, :] - xw), axis=-1) < 0
        nrm[flip] *= -1.0

        interior = np.zeros((h, w), dtype=bool)
        interior[1:-1, 1:-1] = True
        nb_finite = np.zeros((h, w), dtype=bool)
        nb_finite[1:-1, 1:-1] = (
            finite[1:-1, 1:-1] & finite[:-2, 1:-1] & finite[2:, 1:-1]
            & finite[1:-1, :-2] & finite[1:-1, 2:]
        )
        gap = np.full((h, w), np.inf)
        with np.errstate(invalid="ignore"):
            gap[1:-1, 1:-1] = np.maximum.reduce([
                np.abs(d[1:-1, 1:-1] - d[:-2, 1:-1]),
                np.abs(d[1:-1, 1:-1] - d[2:, 1:-1]),
                np.abs(d[1:-1, 1:-1] - d[1:-1, :-2]),
                np.abs(d[1:-1, 1:-1] - d[1:-1, 2:]),
            ]) / np.maximum(d[1:-1, 1:-1], 1e-9)
        finite_n = np.isfinite(nrm).all(axis=-1)
        valid = interior & nb_finite & (gap < 0.05) & finite_n
        normal_maps[r] = np.where(valid[..., None], nrm, 0.0)
        valid_masks[r] = valid

    if corrupt is not None:
        for (r, v, u, factor) in corrupt:
            depth_maps[r, v, u] *= factor
    return depth_maps, normal_maps, valid_masks


def _dist_to_scene(pts: np.ndarray) -> np.ndarray:
    """Unsigned distance from each point to the nearest scene surface (finite plane or box).

    A point on the plane gives ~0 via the plane term; a point on a box face gives ~0 via the box
    term (distance to the clamped AABB point). A point floating in empty space is far from both.
    """
    on_plane = (np.abs(pts[:, 0]) <= _PLANE_HALF) & (np.abs(pts[:, 2]) <= _PLANE_HALF)
    d_plane = np.where(on_plane, np.abs(pts[:, 1] - _PLANE_Y), np.inf)
    clamped = np.clip(pts, _BOX_MIN, _BOX_MAX)
    d_box = np.linalg.norm(pts - clamped, axis=1)
    return np.minimum(d_plane, d_box)


def _confirming_views(scene, x_world, ref, depth_maps, valid_masks, tol=0.01) -> int:
    """How many OTHER views confirm world point ``x_world`` by depth (the covisibility gate)."""
    cnt = 0
    n, h, w = depth_maps.shape
    for j in range(n):
        if j == ref:
            continue
        u, v, z = reproject(x_world[None, :], scene.K, scene.poses_w2c[j])
        ui, vi = int(round(float(u[0]))), int(round(float(v[0])))
        if z[0] <= 0 or not (0 <= ui < w and 0 <= vi < h):
            continue
        dj = depth_maps[j, vi, ui]
        if not (valid_masks[j, vi, ui] and np.isfinite(dj)):
            continue
        if abs(z[0] - dj) / z[0] < tol:
            cnt += 1
    return cnt


def _pick_covisible_pixels(scene, ref, depth_maps, valid_masks, want=4, min_other=3):
    """Interior valid pixels of ``ref`` whose world point is confirmed by ≥ ``min_other`` views."""
    picks = []
    h, w = depth_maps[ref].shape
    for v in range(24, h - 24, 5):
        for u in range(24, w - 24, 5):
            if not valid_masks[ref, v, u]:
                continue
            x = unproject(
                np.array([depth_maps[ref, v, u]]),
                np.array([float(u)]),
                np.array([float(v)]),
                scene.K,
                scene.poses_w2c[ref],
            )[0]
            if _confirming_views(scene, x, ref, depth_maps, valid_masks) >= min_other:
                picks.append((v, u))
            if len(picks) >= want:
                return picks
    return picks


def test_fused_points_lie_on_scene_surfaces():
    scene = _scene()
    depth_maps, normal_maps, valid_masks = _build_view_inputs(scene)
    pts, nrm = fuse(depth_maps, normal_maps, valid_masks, scene.poses_w2c, scene.K)
    assert pts.shape[0] > 500, "fusion produced a degenerately small cloud"
    diam = _scene_diameter(scene)
    med = float(np.median(_dist_to_scene(pts)))
    assert med < 0.01 * diam, f"median surface distance {med:.4f} ≥ 1% of scene diameter {diam:.3f}"


def test_bad_depth_pixels_are_killed_consistent_survive():
    scene = _scene()
    ref = 3
    depth_maps, normal_maps, valid_masks = _build_view_inputs(scene)
    diam = _scene_diameter(scene)

    pix = _pick_covisible_pixels(scene, ref, depth_maps, valid_masks, want=4, min_other=3)
    assert len(pix) >= 3, "could not find enough covisible pixels to plant bad depth"

    true_pts, bad_pts = [], []
    for (v, u) in pix:
        d = depth_maps[ref, v, u]
        args = (np.array([float(u)]), np.array([float(v)]), scene.K, scene.poses_w2c[ref])
        true_pts.append(unproject(np.array([d]), *args)[0])
        bad_pts.append(unproject(np.array([d * 0.6]), *args)[0])
    true_pts = np.array(true_pts)
    bad_pts = np.array(bad_pts)

    # Baseline: with clean depths, the consistent pixels survive fusion.
    clean_pts, _ = fuse(depth_maps, normal_maps, valid_masks, scene.poses_w2c, scene.K)
    clean_tree = cKDTree(clean_pts)
    assert (clean_tree.query(true_pts)[0] < 0.02 * diam).all(), "consistent pixels absent from clean fuse"

    # Corrupt those pixels' depth in the reference view only, then fuse.
    corrupt = [(ref, v, u, 0.6) for (v, u) in pix]
    cd, _, _ = _build_view_inputs(scene, corrupt=corrupt)
    pts, _ = fuse(cd, normal_maps, valid_masks, scene.poses_w2c, scene.K)
    tree = cKDTree(pts)

    # The WRONG (corrupted) world points are killed — nothing near them survives.
    assert (tree.query(bad_pts)[0] > 0.05 * diam).all(), "a bad-depth pixel survived fusion"
    # The TRUE surface points still survive (recovered from the other, uncorrupted views).
    assert (tree.query(true_pts)[0] < 0.02 * diam).all(), "a consistent pixel was wrongly killed"


def test_max_points_cap_enforced_exactly():
    scene = _scene()
    depth_maps, normal_maps, valid_masks = _build_view_inputs(scene)
    for cap in (5, 50, 250):
        pts, nrm = fuse(depth_maps, normal_maps, valid_masks, scene.poses_w2c, scene.K, max_points=cap)
        assert pts.shape[0] <= cap, f"cap {cap} violated: got {pts.shape[0]} points"
        assert nrm.shape[0] == pts.shape[0]


def test_voxel_downsample_is_deterministic():
    scene = _scene()
    depth_maps, normal_maps, valid_masks = _build_view_inputs(scene)
    p1, n1 = fuse(depth_maps, normal_maps, valid_masks, scene.poses_w2c, scene.K, max_points=2000)
    p2, n2 = fuse(depth_maps, normal_maps, valid_masks, scene.poses_w2c, scene.K, max_points=2000)
    assert np.array_equal(p1, p2)
    assert np.array_equal(n1, n2)


def test_output_normals_unit_length_and_shape():
    scene = _scene()
    depth_maps, normal_maps, valid_masks = _build_view_inputs(scene)
    pts, nrm = fuse(depth_maps, normal_maps, valid_masks, scene.poses_w2c, scene.K)
    assert pts.ndim == 2 and pts.shape[1] == 3
    assert nrm.shape == pts.shape
    lengths = np.linalg.norm(nrm, axis=1)
    assert np.allclose(lengths, 1.0, atol=1e-9), "output normals are not unit length"


def test_empty_input_returns_empty_cloud():
    scene = _scene()
    depth_maps, normal_maps, valid_masks = _build_view_inputs(scene)
    empty_valid = np.zeros_like(valid_masks)
    pts, nrm = fuse(depth_maps, normal_maps, empty_valid, scene.poses_w2c, scene.K)
    assert pts.shape == (0, 3)
    assert nrm.shape == (0, 3)
