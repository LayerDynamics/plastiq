"""MLX plane-sweep multi-view stereo: per-view depth + normal estimation (P9.1, SPEC-13 §5.5).

For one registered *reference* view this warps a handful of baseline-selected neighbour views onto the
reference over a fan of fronto-parallel depth hypotheses, scores each hypothesis by a windowed **ZNCC**
photometric cost aggregated across neighbours, and picks the winning depth per pixel (winner-take-all +
parabolic sub-pixel refinement). Per-pixel normals come from the cross product of the unprojected
depth-grid gradients, oriented toward the camera. The output — ``(depth, normals, valid)`` — feeds the
P9.2 multi-view-consistency fusion that unprojects the survivors into a dense oriented point cloud.

Geometry. The reference pixel ``x`` at hypothesis depth ``d`` back-projects to the camera-frame point
``X_ref = d·K⁻¹x`` (the last row of ``K⁻¹`` is ``[0,0,1]`` so its z-component is ``d``); mapping into a
neighbour by the relative pose ``X_nbr = R_rel·X_ref + t_rel`` and re-projecting gives the
plane-induced homography ``H(d) = K(R_rel + t_rel·nᵀ/d)K⁻¹`` with ``n = [0,0,1]`` the fronto-parallel
plane normal in the reference frame (Hartley & Zisserman, *Multiple View Geometry* §13.1). Because only
``1/d`` varies, ``H(d)·x`` reduces to ``A·x + (1/d)·(K·t_rel)`` with ``A = K·R_rel·K⁻¹`` fixed across
hypotheses — the whole sweep is a base warp plus a scaled offset, so the heavy work is one gather
(bilinear resample) and a few box-filter sums per neighbour.

Attribution (no code copied): Collins, *A space-sweep approach to true multi-image matching*, CVPR
1996 (the plane-sweep formulation); Hartley & Zisserman (the plane-induced homography); the
depth→normals cross-product follows the ADR-0006 ``depth_to_normals`` math, reimplemented in-service
(the nerf precedent of sharing a *convention*, not an import). No ``cv2``/``pycolmap`` here (D-1).

Numerics (docs/adr/0013 D-9/D-10): the raster hot path — homography warp, bilinear gather, ZNCC cost
volumes — runs in ``mlx.core`` **float32** with gather + matmul + elementwise ops only (no scatter,
which is non-deterministic on the GPU); pose bookkeeping and the cheap normal cross-product run in
numpy float64. There is no RNG and every reduction order is fixed, so two runs on the same input and
machine return identical arrays.
"""

from __future__ import annotations

import mlx.core as mx
import numpy as np

__all__ = ["plane_sweep", "select_neighbors", "depth_to_normals"]

# --- defaults (SPEC-13 §5.5 / plan P9.1) -------------------------------------------------------
_N_HYPOTHESES = 96
_WINDOW = 5
_N_NEIGHBORS = 4
_MAX_BASELINE_DEG = 45.0  # neighbours whose optical axis is within this of the reference "overlap"
_ZNCC_VALID = 0.5  # a returned-valid pixel needs its aggregated ZNCC above this (confident match)
_EPS = 1e-6


def _rotation(pose_w2c: np.ndarray) -> np.ndarray:
    return np.asarray(pose_w2c, dtype=np.float64)[:, :3]


def _translation(pose_w2c: np.ndarray) -> np.ndarray:
    return np.asarray(pose_w2c, dtype=np.float64)[:, 3]


def _optical_axis(pose_w2c: np.ndarray) -> np.ndarray:
    """Camera +z (forward) direction in world coordinates: ``Rᵀ·[0,0,1] = R[2, :]``."""
    return _rotation(pose_w2c)[2, :]


def select_neighbors(ref_idx: int, poses_w2c: np.ndarray, n_neighbors: int = _N_NEIGHBORS,
                     max_baseline_deg: float = _MAX_BASELINE_DEG) -> list[int]:
    """Pick ``n_neighbors`` views for the reference by baseline angle — widest, but still overlapping.

    The baseline angle is the angle between optical axes; a candidate "overlaps" the reference when
    that angle is ``<= max_baseline_deg`` (for a bounded, object-centric capture the frustums then
    still share most of the scene). Among the overlapping candidates the **widest** baselines are
    taken (they triangulate depth best); if fewer than ``n_neighbors`` overlap, the nearest remaining
    views fill in. Deterministic: ties break by ascending view index.
    """
    poses = np.asarray(poses_w2c, dtype=np.float64)
    n = poses.shape[0]
    dir_ref = _optical_axis(poses[ref_idx])
    angles: dict[int, float] = {}
    for k in range(n):
        if k == ref_idx:
            continue
        c = float(np.clip(np.dot(dir_ref, _optical_axis(poses[k])), -1.0, 1.0))
        angles[k] = float(np.degrees(np.arccos(c)))

    overlapping = [k for k in angles if angles[k] <= max_baseline_deg]
    overlapping.sort(key=lambda k: (-angles[k], k))  # widest first
    selected = overlapping[:n_neighbors]
    if len(selected) < n_neighbors:
        rest = [k for k in angles if k not in set(selected)]
        rest.sort(key=lambda k: (angles[k], k))  # nearest first
        selected += rest[: n_neighbors - len(selected)]
    return sorted(selected)


def _to_gray(images: np.ndarray) -> np.ndarray:
    """(N, H, W, 3) uint8 → (N, H, W) float32 luma in [0, 1] (Rec.601 weights)."""
    arr = np.asarray(images)
    if arr.ndim == 3:  # a single (H, W, 3) image
        arr = arr[None]
    w = np.array([0.299, 0.587, 0.114], dtype=np.float32)
    return (arr[..., :3].astype(np.float32) @ w) / np.float32(255.0)


def _relative_pose(pose_ref: np.ndarray, pose_nbr: np.ndarray):
    """Relative pose ref-camera → neighbour-camera: ``R_rel, t_rel`` with ``X_nbr = R_rel X_ref + t_rel``."""
    r_ref, t_ref = _rotation(pose_ref), _translation(pose_ref)
    r_nbr, t_nbr = _rotation(pose_nbr), _translation(pose_nbr)
    r_rel = r_nbr @ r_ref.T
    t_rel = t_nbr - r_rel @ t_ref
    return r_rel, t_rel


def _box_sum(x: mx.array, window: int) -> mx.array:
    """Windowed sum of a batched ``(N, H, W)`` float32 array (edge-padded → same size)."""
    p = window // 2
    xn = x[:, :, :, None]  # NHWC, single channel
    xp = mx.pad(xn, [(0, 0), (p, p), (p, p), (0, 0)], mode="edge")
    ker = mx.ones((1, window, window, 1), dtype=x.dtype)
    out = mx.conv2d(xp, ker, stride=1, padding=0)
    return out[:, :, :, 0]


def _bilinear_gather(gray_flat: mx.array, u: mx.array, v: mx.array, h: int, w: int) -> mx.array:
    """Bilinearly sample a flattened ``(H*W,)`` image at clamped ``(u, v)`` coords (any shape)."""
    uc = mx.clip(u, 0.0, float(w - 1))
    vc = mx.clip(v, 0.0, float(h - 1))
    x0 = mx.floor(uc)
    y0 = mx.floor(vc)
    x0i = x0.astype(mx.int32)
    y0i = y0.astype(mx.int32)
    x1i = mx.minimum(x0i + 1, w - 1)
    y1i = mx.minimum(y0i + 1, h - 1)
    wx = uc - x0
    wy = vc - y0

    def at(yy, xx):
        return mx.take(gray_flat, yy * w + xx)

    c00 = at(y0i, x0i)
    c01 = at(y0i, x1i)
    c10 = at(y1i, x0i)
    c11 = at(y1i, x1i)
    top = c00 * (1.0 - wx) + c01 * wx
    bot = c10 * (1.0 - wx) + c11 * wx
    return top * (1.0 - wy) + bot * wy


def _sweep_neighbor(gray_nbr: np.ndarray, base: np.ndarray, offset: np.ndarray,
                    inv_depths: np.ndarray, h: int, w: int):
    """Warp one neighbour over all depth hypotheses → ``(zncc-ready intensity, valid-mask)`` MLX arrays.

    ``base`` (3, H*W) is ``A·x`` and ``offset`` (3,) is ``K·t_rel`` (numpy); the neighbour pixel for
    hypothesis ``i`` is ``base + inv_depths[i]·offset``. Returns the warped intensity ``(n_hyp, H*W)``
    and a boolean in-frame / in-front mask ``(n_hyp, H*W)`` (MLX float32).
    """
    base_mx = mx.array(base.astype(np.float32))  # (3, HW)
    off_mx = mx.array(offset.astype(np.float32))  # (3,)
    invd_mx = mx.array(inv_depths.astype(np.float32))  # (n_hyp,)
    # p[i] = base + invd[i] * offset  →  (n_hyp, 3, HW)
    p = base_mx[None, :, :] + invd_mx[:, None, None] * off_mx[None, :, None]
    z = p[:, 2, :]
    safe_z = mx.where(mx.abs(z) < _EPS, mx.array(_EPS, dtype=z.dtype), z)
    u = p[:, 0, :] / safe_z
    v = p[:, 1, :] / safe_z
    in_front = z > _EPS
    in_bounds = (u >= 0.0) & (u <= float(w - 1)) & (v >= 0.0) & (v <= float(h - 1)) & in_front
    gray_flat = mx.array(gray_nbr.reshape(-1))
    warped = _bilinear_gather(gray_flat, u, v, h, w)
    mask = in_bounds.astype(mx.float32)
    return warped, mask


def _zncc_volume(gray_ref: mx.array, s_r: mx.array, s_rr: mx.array, var_r: mx.array,
                 warped: mx.array, mask: mx.array, window: int, n_hyp: int, h: int, w: int):
    """Per-hypothesis ZNCC of the reference against one warped neighbour + a per-pixel valid flag.

    ``s_r, s_rr, var_r`` are the reference's fixed windowed sums / variance ``(H, W)``. Returns the
    ZNCC cost volume ``(n_hyp, H, W)`` and a boolean valid volume (centre in-frame and both windows
    have non-degenerate variance).
    """
    npix = float(window * window)
    iw = warped.reshape(n_hyp, h, w)
    s_n = _box_sum(iw, window)
    s_nn = _box_sum(iw * iw, window)
    s_rn = _box_sum(gray_ref[None, :, :] * iw, window)
    var_n = mx.maximum(s_nn - s_n * s_n / npix, 0.0)
    cov = s_rn - s_r[None, :, :] * s_n / npix
    denom = mx.sqrt(var_r[None, :, :] * var_n)
    zncc = cov / (denom + _EPS)
    center = mask.reshape(n_hyp, h, w) > 0.5
    valid = center & (var_n > _EPS) & (var_r[None, :, :] > _EPS)
    return zncc, valid


def plane_sweep(ref_idx, images, poses_w2c, K, *, n_hypotheses: int = _N_HYPOTHESES,
                window: int = _WINDOW, n_neighbors: int = _N_NEIGHBORS, depth_range=None):
    """Estimate a per-pixel depth + normal map for reference view ``ref_idx`` by plane-sweep MVS.

    Args:
        ref_idx: index of the reference view in ``images`` / ``poses_w2c``.
        images: ``(N, H, W, 3)`` uint8 views.
        poses_w2c: ``(N, 3, 4)`` OpenCV +z-forward world→camera ``[R | t]``.
        K: ``(3, 3)`` shared intrinsics.
        n_hypotheses: number of fronto-parallel depth planes spanning the depth range.
        window: ZNCC correlation-window side (odd).
        n_neighbors: neighbour views to sweep (selected by baseline angle).
        depth_range: ``(d_min, d_max)`` camera-Z span to sweep; when ``None`` it is estimated from the
            camera geometry (the least-squares intersection of the views' optical axes) — a fallback
            for standalone use; the P9.2 pipeline passes the sparse-track depth range explicitly.

    Returns:
        ``(depth (H, W) float32, normals (H, W, 3) float32, valid (H, W) bool)``. ``depth`` is the
        winner-take-all + parabolic-refined camera-Z per pixel (NaN where no neighbour constrains it);
        ``normals`` are unit, oriented toward the camera; ``valid`` marks confident matches.
    """
    images = np.asarray(images)
    poses = np.asarray(poses_w2c, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    n, h, w = images.shape[0], images.shape[1], images.shape[2]
    if window % 2 == 0:
        raise ValueError(f"window must be odd; got {window}")
    if n < 2:
        raise ValueError("plane_sweep needs at least two views")

    gray = _to_gray(images)  # (N, H, W) float32
    neighbors = select_neighbors(ref_idx, poses, n_neighbors)
    if not neighbors:
        raise ValueError("no neighbour views available for the reference")

    d_min, d_max = _resolve_depth_range(ref_idx, poses, K, neighbors, depth_range)
    depths = np.linspace(d_min, d_max, n_hypotheses).astype(np.float64)
    inv_depths = 1.0 / depths
    step = float(depths[1] - depths[0]) if n_hypotheses > 1 else 0.0

    # reference pixel grid [u; v; 1] and its fixed windowed statistics
    uu, vv = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    grid = np.stack([uu.ravel(), vv.ravel(), np.ones(h * w)], axis=0)  # (3, HW)
    k_inv = np.linalg.inv(K)

    gray_ref = mx.array(gray[ref_idx])
    s_r = _box_sum(gray_ref[None], window)[0]
    s_rr = _box_sum((gray_ref * gray_ref)[None], window)[0]
    var_r = mx.maximum(s_rr - s_r * s_r / float(window * window), 0.0)

    agg_sum = mx.zeros((n_hypotheses, h, w), dtype=mx.float32)
    agg_cnt = mx.zeros((n_hypotheses, h, w), dtype=mx.float32)
    for k in neighbors:
        r_rel, t_rel = _relative_pose(poses[ref_idx], poses[k])
        a_mat = K @ r_rel @ k_inv  # (3, 3)
        base = a_mat @ grid  # (3, HW)
        offset = K @ t_rel  # (3,)
        warped, mask = _sweep_neighbor(gray[k], base, offset, inv_depths, h, w)
        zncc, valid = _zncc_volume(gray_ref, s_r, s_rr, var_r, warped, mask,
                                   window, n_hypotheses, h, w)
        vf = valid.astype(mx.float32)
        agg_sum = agg_sum + mx.where(valid, zncc, mx.array(0.0, dtype=mx.float32))
        agg_cnt = agg_cnt + vf
    mx.eval(agg_sum, agg_cnt)

    # aggregate ZNCC across neighbours; hypotheses with no valid neighbour are pushed below any real
    # score so they never win the argmax
    has = agg_cnt > 0.5
    agg = mx.where(has, agg_sum / mx.maximum(agg_cnt, 1.0), mx.array(-2.0, dtype=mx.float32))

    best_idx = mx.argmax(agg, axis=0)  # (H, W)
    depth, best_val, best_cnt = _wta_subpixel(agg, agg_cnt, best_idx, depths, step, n_hypotheses)

    depth_np = np.asarray(depth, dtype=np.float32)
    best_val_np = np.asarray(best_val, dtype=np.float32)
    best_cnt_np = np.asarray(best_cnt, dtype=np.float32)
    var_r_np = np.asarray(var_r, dtype=np.float32)

    unconstrained = best_cnt_np < 0.5
    depth_np = np.where(unconstrained, np.float32(np.nan), depth_np)
    valid_out = (best_cnt_np >= 0.5) & (best_val_np > _ZNCC_VALID) & (var_r_np > _EPS)
    valid_out &= np.isfinite(depth_np)

    normals = depth_to_normals(depth_np, K)
    return depth_np.astype(np.float32), normals.astype(np.float32), valid_out.astype(bool)


def _wta_subpixel(agg: mx.array, agg_cnt: mx.array, best_idx: mx.array, depths: np.ndarray,
                  step: float, n_hyp: int):
    """Winner-take-all depth + parabolic sub-pixel refinement across the 3 costs around the winner."""
    idx = best_idx[None, :, :]  # (1, H, W)
    idx_lo = mx.clip(best_idx - 1, 0, n_hyp - 1)[None]
    idx_hi = mx.clip(best_idx + 1, 0, n_hyp - 1)[None]
    c0 = mx.take_along_axis(agg, idx, axis=0)[0]
    cm = mx.take_along_axis(agg, idx_lo, axis=0)[0]
    cp = mx.take_along_axis(agg, idx_hi, axis=0)[0]
    best_cnt = mx.take_along_axis(agg_cnt, idx, axis=0)[0]

    denom = cm - 2.0 * c0 + cp
    delta = mx.where(mx.abs(denom) > _EPS, 0.5 * (cm - cp) / denom, mx.array(0.0, dtype=agg.dtype))
    delta = mx.clip(delta, -0.5, 0.5)
    at_edge = (best_idx == 0) | (best_idx == (n_hyp - 1))
    delta = mx.where(at_edge, mx.array(0.0, dtype=agg.dtype), delta)

    depths_mx = mx.array(depths.astype(np.float32))
    depth0 = mx.take(depths_mx, best_idx)
    depth = depth0 + delta * float(step)
    mx.eval(depth, c0, best_cnt)
    return depth, c0, best_cnt


def _resolve_depth_range(ref_idx: int, poses: np.ndarray, K: np.ndarray, neighbors: list[int],
                         depth_range):
    """The ``(d_min, d_max)`` depth span to sweep, given or estimated from optical-axis convergence."""
    if depth_range is not None:
        d_min, d_max = float(depth_range[0]), float(depth_range[1])
        if not (d_max > d_min > 0):
            raise ValueError(f"depth_range must be 0 < d_min < d_max; got {depth_range}")
        return d_min, d_max

    # fallback: least-squares intersection of the views' optical-axis rays (a scene-centre proxy),
    # then sweep a padded band around the reference camera's distance to it
    idxs = [ref_idx, *neighbors]
    a = np.zeros((3, 3))
    b = np.zeros(3)
    for k in idxs:
        r, t = poses[k][:, :3], poses[k][:, 3]
        c = -r.T @ t  # camera centre
        d = r[2, :]  # optical axis (world)
        proj = np.eye(3) - np.outer(d, d)
        a += proj
        b += proj @ c
    center = np.linalg.solve(a, b)
    r_ref, t_ref = poses[ref_idx][:, :3], poses[ref_idx][:, 3]
    d_center = float((r_ref @ center + t_ref)[2])
    d_center = max(d_center, _EPS)
    return 0.4 * d_center, 1.8 * d_center


def depth_to_normals(depth: np.ndarray, K: np.ndarray) -> np.ndarray:
    """Per-pixel unit normals from a camera-Z depth map, oriented toward the camera (SPEC-13 §5.5).

    Unprojects each pixel to its camera-frame point ``P = (x, y, z)`` with ``z = depth``,
    ``x = (u-cx)/fx·z``, ``y = (v-cy)/fy·z``, then normals are ``normalize(∂P/∂u × ∂P/∂v)`` flipped so
    each points back toward the camera (``n·P < 0`` — the camera sits at the origin looking +z).
    Pixels whose depth or whose central-difference neighbours are non-finite get NaN normals.
    """
    depth = np.asarray(depth, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    h, w = depth.shape
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]

    uu, vv = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    z = depth
    x = (uu - cx) / fx * z
    y = (vv - cy) / fy * z
    p = np.stack([x, y, z], axis=2)  # (H, W, 3)

    dpu = np.full_like(p, np.nan)
    dpv = np.full_like(p, np.nan)
    dpu[:, 1:-1, :] = (p[:, 2:, :] - p[:, :-2, :]) * 0.5  # ∂P/∂u (columns)
    dpv[1:-1, :, :] = (p[2:, :, :] - p[:-2, :, :]) * 0.5  # ∂P/∂v (rows)

    nrm = np.cross(dpu, dpv)
    length = np.linalg.norm(nrm, axis=2, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        unit = nrm / length
    # orient toward the camera: flip where the normal points away from the origin (n·P > 0)
    dot = np.sum(unit * p, axis=2, keepdims=True)
    unit = np.where(dot > 0.0, -unit, unit)

    bad = (~np.isfinite(unit).all(axis=2)) | (length[..., 0] < _EPS) | (~np.isfinite(z))
    unit[bad] = np.nan
    return unit.astype(np.float32)
