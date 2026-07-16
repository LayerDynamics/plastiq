"""Multi-view geometric-consistency fusion → dense oriented point cloud (SPEC-13 §5.5, D-2; P9.2).

The second dense-MVS stage. It consumes the plane-sweep stage's (`mvs/plane_sweep.py`) per-view
outputs — depth maps, **world-frame** unit normal maps, and validity masks — and fuses them into the
single ``{points, normals}`` oriented cloud that ``services/capture`` ``POST /capture`` ingests
(`services/capture/app/main.py:70-74`; FR-5). No RNG, no MLX: pure numpy/float64, deterministic by
construction (SPEC-13 NFR-1) — the CPU/combinatorial half of the two-tier numerics policy (D-9).

Method (SPEC-13 §5.5):
  1. **Per-reference-view unprojection.** Each valid, finite-depth pixel of a reference view is
     unprojected to a world point using that view's pose + shared intrinsics ``K``.
  2. **Multi-view geometric consistency.** The world point survives only if at least
     ``min_views - 1`` OTHER views confirm it: reprojected into that view, the neighbouring measured
     depth agrees within a relative gap ``rel_depth_tol``, AND the world normals agree
     (dot > ``normal_dot``). This is what kills wrong-depth (plane-sweep mismatch) pixels.
  3. **Deterministic voxel downsample.** Survivors are deduplicated on a voxel grid whose cell size
     is grown (fixed 1.5× steps from a fine start) until the occupied-voxel count fits ``max_points``
     (`PHOTOGRAMMETRY_MAX_DENSE_POINTS`, default 200 000, matching capture's ``CAPTURE_MAX_POINTS``);
     one representative per occupied voxel is the point/normal centroid (order-independent, so two
     runs are bit-identical).

Normal-map convention (the contract the plane-sweep stage emits and this module compares): each
``normal_maps[view]`` pixel is a **world-frame** unit normal (from the unprojected depth-grid
gradient cross product, signed toward the camera). World-frame is what makes the cross-view
dot-product agreement in step 2 meaningful — the same surface point has one world normal regardless
of which camera saw it.
"""

from __future__ import annotations

import numpy as np

__all__ = ["fuse", "unproject", "reproject"]

# Default dense-cloud cap — PHOTOGRAMMETRY_MAX_DENSE_POINTS, mirroring capture's CAPTURE_MAX_POINTS.
_DEFAULT_MAX_POINTS = 200_000
# Fine initial voxel resolution (cells across the cloud's bounding-box diagonal) before any growth.
_INIT_VOXEL_RES = 512.0


def unproject(depths, us, vs, K, pose_w2c) -> np.ndarray:
    """Unproject pixels ``(us, vs)`` at camera-space ``depths`` → ``(P, 3)`` world points.

    ``pose_w2c`` is the world-to-camera ``[R | t]`` (3×4): a world point maps to camera space by
    ``X_c = R X + t``, so the inverse is ``X = Rᵀ (X_c - t)`` (written row-wise as ``(X_c - t) @ R``).
    """
    depths = np.asarray(depths, dtype=np.float64)
    us = np.asarray(us, dtype=np.float64)
    vs = np.asarray(vs, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    R, t = pose_w2c[:, :3], pose_w2c[:, 3]
    xn = (us - K[0, 2]) / K[0, 0]
    yn = (vs - K[1, 2]) / K[1, 1]
    x_cam = np.stack([xn * depths, yn * depths, depths], axis=-1)  # (P, 3)
    return (x_cam - t) @ R


def reproject(points_w, K, pose_w2c):
    """Reproject ``(P, 3)`` world points into a view → ``(us, vs, zs)`` (pixels + camera-space depth)."""
    points_w = np.asarray(points_w, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    R, t = pose_w2c[:, :3], pose_w2c[:, 3]
    x_cam = points_w @ R.T + t  # (P, 3)
    z = x_cam[:, 2]
    us = K[0, 0] * x_cam[:, 0] / z + K[0, 2]
    vs = K[1, 1] * x_cam[:, 1] / z + K[1, 2]
    return us, vs, z


def _unit(vecs: np.ndarray) -> np.ndarray:
    """Row-normalise ``(P, 3)`` vectors; a degenerate (near-zero) row falls back to +z deterministically."""
    lengths = np.linalg.norm(vecs, axis=1, keepdims=True)
    out = np.zeros_like(vecs)
    nz = lengths[:, 0] > 1e-12
    out[nz] = vecs[nz] / lengths[nz]
    out[~nz] = np.array([0.0, 0.0, 1.0])
    return out


def _voxel_downsample(points: np.ndarray, normals: np.ndarray, max_points: int):
    """Deduplicate/downsample to ≤ ``max_points`` on a deterministic voxel grid (centroid per cell)."""
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    diag = float(np.linalg.norm(hi - lo))
    if diag <= 0.0:  # all survivors coincide → a single representative
        return points[:1].copy(), _unit(normals[:1])

    voxel = diag / _INIT_VOXEL_RES
    while True:
        keys = np.floor((points - lo) / voxel).astype(np.int64)
        uniq, inv = np.unique(keys, axis=0, return_inverse=True)
        inv = np.asarray(inv).reshape(-1)  # numpy-2.x may return a column vector for axis=0
        if uniq.shape[0] <= max_points or voxel >= diag:
            break
        voxel *= 1.5

    counts = np.bincount(inv, minlength=uniq.shape[0]).astype(np.float64)
    sum_p = np.zeros((uniq.shape[0], 3), dtype=np.float64)
    sum_n = np.zeros((uniq.shape[0], 3), dtype=np.float64)
    np.add.at(sum_p, inv, points)
    np.add.at(sum_n, inv, normals)
    centroids = sum_p / counts[:, None]
    unit_normals = _unit(sum_n)
    if centroids.shape[0] > max_points:  # only when the grid bottomed out at ≤ 8 coarse cells
        centroids = centroids[:max_points]
        unit_normals = unit_normals[:max_points]
    return centroids, unit_normals


def fuse(
    depth_maps,
    normal_maps,
    valid_masks,
    poses_w2c,
    K,
    *,
    max_points: int = _DEFAULT_MAX_POINTS,
    rel_depth_tol: float = 0.01,
    normal_dot: float = 0.7,
    min_views: int = 2,
):
    """Fuse per-view depth+normal maps into a dense oriented point cloud.

    Args:
        depth_maps: ``(N, H, W)`` camera-space Z per pixel (non-finite = no surface).
        normal_maps: ``(N, H, W, 3)`` WORLD-frame unit normals (see the module docstring).
        valid_masks: ``(N, H, W)`` bool — pixels with a trustworthy depth+normal.
        poses_w2c: ``(N, 3, 4)`` world-to-camera ``[R | t]`` (OpenCV +z-forward).
        K: ``(3, 3)`` shared intrinsics.
        max_points: voxel-downsample cap (``PHOTOGRAMMETRY_MAX_DENSE_POINTS``); output ≤ this.
        rel_depth_tol: relative depth-gap threshold for a confirming view (default 1%).
        normal_dot: minimum world-normal dot product for a confirming view (default 0.7).
        min_views: total views that must see a point (≥ ``min_views - 1`` OTHER confirmations).

    Returns:
        ``(points (M, 3), normals (M, 3))`` — oriented cloud in the input (normalized world) frame.
    """
    depth_maps = np.asarray(depth_maps, dtype=np.float64)
    normal_maps = np.asarray(normal_maps, dtype=np.float64)
    valid_masks = np.asarray(valid_masks, dtype=bool)
    poses_w2c = np.asarray(poses_w2c, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    n_views, height, width = depth_maps.shape
    need = max(min_views - 1, 0)

    kept_pts: list[np.ndarray] = []
    kept_nrm: list[np.ndarray] = []
    for ref in range(n_views):
        ref_ok = valid_masks[ref] & np.isfinite(depth_maps[ref])
        vs, us = np.nonzero(ref_ok)
        if us.size == 0:
            continue
        depths = depth_maps[ref, vs, us]
        world = unproject(depths, us.astype(np.float64), vs.astype(np.float64), K, poses_w2c[ref])
        ref_normals = normal_maps[ref, vs, us]  # (P, 3) world-frame

        agree = np.zeros(us.shape[0], dtype=np.int64)
        for j in range(n_views):
            if j == ref:
                continue
            uj, vj, zj = reproject(world, K, poses_w2c[j])
            ui = np.round(uj).astype(np.int64)
            vi = np.round(vj).astype(np.int64)
            in_bounds = (zj > 0) & (ui >= 0) & (ui < width) & (vi >= 0) & (vi < height)
            if not in_bounds.any():
                continue
            idx = np.nonzero(in_bounds)[0]
            uic, vic = ui[idx], vi[idx]
            dj = depth_maps[j, vic, uic]
            valid_j = valid_masks[j, vic, uic] & np.isfinite(dj)
            with np.errstate(invalid="ignore"):
                rel = np.abs(zj[idx] - dj) / np.maximum(zj[idx], 1e-12)
            ndot = np.sum(ref_normals[idx] * normal_maps[j, vic, uic], axis=1)
            confirm = valid_j & (rel < rel_depth_tol) & (ndot > normal_dot)
            agree[idx[confirm]] += 1

        keep = agree >= need
        if keep.any():
            kept_pts.append(world[keep])
            kept_nrm.append(ref_normals[keep])

    if not kept_pts:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0, 3), dtype=np.float64)
    points = np.concatenate(kept_pts, axis=0)
    normals = np.concatenate(kept_nrm, axis=0)
    return _voxel_downsample(points, normals, max_points)
