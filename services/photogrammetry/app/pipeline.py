"""Sparse SfM pipeline orchestration (SPEC-13 §5.1, plan P7.1) — the service entrypoint's sparse half.

Composes the verified stages into ``photos → camera poses + sparse cloud + transforms.json``:

    images → exif intrinsics prior → features (detect + describe) → match → tracks → init pair →
    incremental reconstruct → normalize → emit (transforms.json + sparse PLY)

The dense MVS half (``app.mvs`` plane-sweep + fusion → dense oriented cloud) is appended by P9. Shared
single-camera intrinsics are assumed (one device); the prior comes from the first image's EXIF via
``app.exif`` (sensor-width DB aware) and is refined by bundle adjustment when ``self_calibrate`` is set.

Heavy per-image feature work runs in MLX (via ``app.core.features``); the sparse solvers are
numpy/scipy float64 (D-9). Deterministic given the seed (D-10).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

from app.core.features import detect_and_describe
from app.core.match import match_image_set
from app.emit import emit_transforms_json, write_ply_dense, write_ply_sparse
from app.exif import intrinsics_prior
from app.normalize import normalize_scene
from app.sfm import (
    build_tracks,
    reconstruct,
    select_init_pair,
    select_init_pairs,
    verify_pair_matches,
)

logger = logging.getLogger(__name__)


@dataclass
class SparseResult:
    """Result of :func:`solve_sparse`."""

    poses_w2c: dict           # {image_idx: (3, 4)} normalized world→camera
    points3d: np.ndarray      # (M, 3) normalized sparse points
    K: np.ndarray             # (3, 3) shared intrinsics (refined if self-calibrated)
    transforms_json: str      # nerfstudio/OpenGL transforms.json
    sparse_ply: str           # ASCII PLY (x y z r g b)
    registered: list          # registered image indices
    report: dict              # images_total/registered, mean_reprojection_error_px, mean_track_length, …


def _to_gray_rgb(img: np.ndarray) -> np.ndarray:
    a = np.asarray(img)
    if a.ndim == 2:
        a = np.stack([a, a, a], axis=-1)
    return a[:, :, :3]


def solve_sparse(
    images,
    *,
    K=None,
    exif_images=None,
    matching: str = "exhaustive",
    window: int = 8,
    max_features: int = 4096,
    ratio: float = 0.8,
    seed: int = 0,
    self_calibrate: bool = False,
    image_names=None,
    detect_kwargs=None,
    undistort: bool = True,
) -> SparseResult:
    """Run the sparse SfM pipeline on ``images`` (a list of ``(H, W, 3)`` uint8 arrays).

    Args:
        images: the photos as numpy arrays.
        K: shared ``(3, 3)`` intrinsics; if ``None`` it is estimated from ``exif_images`` (or a wide
            fallback) — see :func:`app.exif.intrinsics_prior`.
        exif_images: optional per-image EXIF sources (paths/bytes/PIL) parallel to ``images`` for the
            intrinsics prior; the first is used for the shared camera.
        matching: ``"exhaustive"`` or ``"sequential"``.
        max_features: per-image feature cap.
        seed: RANSAC seed (D-10).
        self_calibrate: free the intrinsics in bundle adjustment (else the prior K is held fixed).
        image_names: per-image filenames for the emitter / unregistered reporting.

    Returns:
        A :class:`SparseResult`.
    """
    imgs = [_to_gray_rgb(im) for im in images]
    n = len(imgs)
    h, w = imgs[0].shape[:2]
    names = list(image_names) if image_names is not None else [f"frame_{i:05d}.jpg" for i in range(n)]

    if K is None:
        src = exif_images[0] if exif_images else imgs[0]
        fx, fy, cx, cy = intrinsics_prior(src, w, h)
        K = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]])
    K = np.asarray(K, dtype=np.float64)

    # --- features -----------------------------------------------------------------------------
    dkw = detect_kwargs or {}
    keypoints, descriptors = [], []
    for im in imgs:
        kp, desc = detect_and_describe(im, max_features=max_features, **dkw)
        keypoints.append(kp.xy)
        descriptors.append(desc)

    # --- matching → geometric verification → tracks -------------------------------------------
    pair_matches = match_image_set(descriptors, schedule=matching, window=window, ratio=ratio)
    pair_matches = [(i, j, m) for (i, j, m) in pair_matches if m.shape[0] >= 8]
    # Geometrically verify each pair (RANSAC fundamental) BEFORE union-find track building: on real
    # photos a single wrong match contaminates a multi-view track and collapses PnP inlier ratios, so
    # views that share hundreds of matches with the model still fail to register (COLMAP's verification
    # step — the difference between a stalled mapper and one that registers real photos).
    pair_matches = verify_pair_matches(pair_matches, keypoints, seed=seed)
    tracks = build_tracks(pair_matches, n)

    if not pair_matches or not tracks:
        raise ValueError("no usable matches/tracks — the images may not overlap or lack texture")

    # --- reconstruct ---------------------------------------------------------------------------
    # Ranked init candidates (with fallback in reconstruct) so verification's cleaner scores can't
    # strand the seed on a single narrow/degenerate top pair.
    init_candidates = select_init_pairs(pair_matches, keypoints, K)
    init = init_candidates[0] if init_candidates else select_init_pair(pair_matches, keypoints, K)
    sfm = reconstruct(tracks, keypoints, K, init_pair=init, init_candidates=init_candidates,
                      image_names=names, seed=seed, fix_intrinsics=not self_calibrate)

    # --- normalize ----------------------------------------------------------------------------
    reg = sorted(sfm.registered)
    poses_arr = np.stack([sfm.poses_w2c[v] for v in reg], axis=0)
    tids = sorted(sfm.points3d)
    pts_arr = np.array([sfm.points3d[tid] for tid in tids]) if tids else np.zeros((0, 3))
    norm = normalize_scene(poses_arr, pts_arr)
    poses_norm = {v: norm.poses_w2c[i] for i, v in enumerate(reg)}

    # --- emit ----------------------------------------------------------------------------------
    reg_names = [names[v] for v in reg]
    transforms_json = emit_transforms_json(
        norm.poses_w2c, K, w, h, reg_names, undistort=undistort,
        applied_transform=norm.applied_transform,
    )
    import io
    buf = io.StringIO()
    colors = np.full((pts_arr.shape[0], 3), 200, dtype=np.int64)
    write_ply_sparse(buf, norm.points3d, colors)
    sparse_ply = buf.getvalue()

    # --- report (SPEC-13 FR-8 — the shape the @plastiq/photogrammetry client's PhotogrammetryReport
    # type consumes) -----------------------------------------------------------------------------
    track_lengths = [sum(1 for v in tracks[tid] if v in sfm.poses_w2c) for tid in tids]
    report = {
        "images_total": n,
        "images_registered": len(reg),
        "unregistered_names": sfm.unregistered_names,
        "sparse_points": len(tids),
        "mean_reprojection_error_px": sfm.mean_reproj,
        "mean_track_length": float(np.mean(track_lengths)) if track_lengths else 0.0,
        # The self-calibrated shared camera (§6.2). Distortion is 0 here: the default path holds the
        # EXIF-prior intrinsics fixed and does not estimate Brown-Conrady coefficients, and `undistort`
        # zeroes them on the wire regardless (D-6).
        "camera": {
            "model": "OPENCV",
            "w": w,
            "h": h,
            "fl_x": float(K[0, 0]),
            "fl_y": float(K[1, 1]),
            "cx": float(K[0, 2]),
            "cy": float(K[1, 2]),
            "k1": 0.0,
            "k2": 0.0,
            "p1": 0.0,
            "p2": 0.0,
        },
        # The normalization similarity baked into the emitted poses/points (D-5).
        "normalization": {
            "applied_transform": norm.applied_transform.tolist(),
            "scale": float(norm.scale),
        },
        "matching": matching,
        "seed": seed,
        "undistorted": undistort,
    }

    return SparseResult(
        poses_w2c=poses_norm,
        points3d=norm.points3d,
        K=K,
        transforms_json=transforms_json,
        sparse_ply=sparse_ply,
        registered=reg,
        report=report,
    )


@dataclass
class SolveResult:
    """Result of :func:`solve` — the full SPEC-13 §6.1 payload (sparse + optional dense)."""

    transforms_json: str            # nerfstudio/OpenGL transforms.json (→ services/nerf)
    sparse_ply: str                 # ASCII PLY (x y z r g b)
    dense_ply: str | None           # ASCII PLY (x y z nx ny nz r g b) or None when dense off / empty
    images_undistorted: list | None  # parallel undistorted images, or None when none produced
    report: dict                    # FR-8 report (sparse fields + dense_points)


def _view_depth_range(points3d: np.ndarray, K: np.ndarray, pose_w2c: np.ndarray, w: int, h: int):
    """The camera-Z ``(d_min, d_max)`` span of the sparse points visible in one view, padded ±20%
    (SPEC-13 §5.5 / P9.1). ``None`` when too few sparse points land in the frame — the caller then
    lets ``plane_sweep`` estimate the range from the camera geometry."""
    from app.mvs.fusion import reproject  # noqa: PLC0415 — dense-only dependency

    if points3d.shape[0] == 0:
        return None
    us, vs, zs = reproject(points3d, K, pose_w2c)
    inb = (zs > 0) & (us >= 0) & (us < w) & (vs >= 0) & (vs < h)
    z = zs[inb]
    if z.size < 4:
        return None
    return float(z.min()) * 0.8, float(z.max()) * 1.2


def _dense_colors(points: np.ndarray, images: np.ndarray, K: np.ndarray, poses_w2c: np.ndarray):
    """Per-point RGB for a dense cloud: reproject each point into the registered views and sample the
    colour from the FIRST view that sees it in-frame (deterministic by ascending view order). Points
    seen by no view fall back to neutral grey (200). ``images`` is ``(N, H, W, 3)`` uint8."""
    from app.mvs.fusion import reproject  # noqa: PLC0415 — dense-only dependency

    m = points.shape[0]
    colors = np.full((m, 3), 200, dtype=np.int64)
    assigned = np.zeros(m, dtype=bool)
    n, h, w = images.shape[0], images.shape[1], images.shape[2]
    for ri in range(n):
        us, vs, zs = reproject(points, K, poses_w2c[ri])
        ui = np.round(us).astype(np.int64)
        vi = np.round(vs).astype(np.int64)
        inb = (~assigned) & (zs > 0) & (ui >= 0) & (ui < w) & (vi >= 0) & (vi < h)
        idx = np.nonzero(inb)[0]
        if idx.size:
            colors[idx] = images[ri, vi[idx], ui[idx], :3]
            assigned[idx] = True
    return colors


def solve_dense(
    images_arr: np.ndarray,
    poses_w2c: np.ndarray,
    points3d: np.ndarray,
    K: np.ndarray,
    *,
    max_dense_points: int = 200_000,
    min_views: int = 2,
    rel_depth_tol: float = 0.01,
    normal_dot: float = 0.7,
):
    """Dense MVS orchestration: per-view plane-sweep + fusion → a coloured oriented cloud (P9, §5.5).

    Each view in ``images_arr`` ``(N, H, W, 3)`` uint8 with world→camera pose ``poses_w2c`` ``(N, 3, 4)``
    is depth-mapped by the two-stage :func:`app.mvs.plane_sweep.plane_sweep` (sparse ``points3d`` set its
    depth range); the camera-frame normals are rotated to world (``n_world = n_cam @ R``); the maps are
    fused (:func:`app.mvs.fusion.fuse`) into a downsampled cloud, coloured from the source images, and
    written as an ``x y z nx ny nz r g b`` PLY.

    Dense resolution is independent of the sparse solve: ``images_arr`` may be higher-resolution than
    the images poses were solved on, as long as ``K`` is scaled to match (extrinsics are
    resolution-free) — this is how a robust reduced-res registration is densified at full input
    resolution. ``min_views``/``rel_depth_tol``/``normal_dot`` tune the fusion's geometric-consistency
    gate (forwarded to :func:`app.mvs.fusion.fuse`): raise ``min_views`` for a cleaner (fewer-floater)
    cloud, keep it at 2 to favour density. Defaults reproduce fuse's own defaults.

    Returns ``(dense_ply: str | None, dense_points: int, views_swept: int)``. Degradation (SPEC-13 §7):
    a per-view sweep that raises is skipped (logged, counted); zero fused points ⇒ ``(None, 0, …)``.
    """
    from app.mvs.fusion import fuse  # noqa: PLC0415 — dense-only (MLX) dependency
    from app.mvs.plane_sweep import plane_sweep  # noqa: PLC0415

    images_arr = np.asarray(images_arr)
    poses_w2c = np.asarray(poses_w2c, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    n_reg, h, w = images_arr.shape[0], images_arr.shape[1], images_arr.shape[2]

    depth_maps, world_normals, valids = [], [], []
    swept = 0
    for ri in range(n_reg):
        try:
            dr = _view_depth_range(points3d, K, poses_w2c[ri], w, h)
            depth, n_cam, valid = plane_sweep(ri, images_arr, poses_w2c, K, depth_range=dr)
            swept += 1
        except Exception as e:  # noqa: BLE001 — one view's failure must not sink the dense stage
            logger.warning("dense: view %d plane-sweep failed (%s); skipping", ri, e)
            depth = np.full((h, w), np.nan, dtype=np.float32)
            n_cam = np.full((h, w, 3), np.nan, dtype=np.float32)
            valid = np.zeros((h, w), dtype=bool)
        n_world = n_cam @ poses_w2c[ri][:, :3]  # camera-frame normal → world (n_world = n_cam @ R)
        depth_maps.append(depth)
        world_normals.append(n_world)
        valids.append(valid)

    points, normals = fuse(
        np.stack(depth_maps), np.stack(world_normals), np.stack(valids), poses_w2c, K,
        max_points=max_dense_points, min_views=min_views, rel_depth_tol=rel_depth_tol,
        normal_dot=normal_dot,
    )
    if points.shape[0] == 0:
        return None, 0, swept

    import io  # noqa: PLC0415

    colors = _dense_colors(points, images_arr, K, poses_w2c)
    buf = io.StringIO()
    write_ply_dense(buf, points, normals, colors)
    return buf.getvalue(), int(points.shape[0]), swept


def solve(
    images,
    *,
    dense: bool = True,
    max_dense_points: int = 200_000,
    min_views: int = 2,
    rel_depth_tol: float = 0.01,
    normal_dot: float = 0.7,
    dense_images=None,
    dense_K=None,
    **sparse_kwargs,
) -> SolveResult:
    """Run the full photogrammetry solve: sparse SfM, then (``dense``) the MLX plane-sweep MVS + fusion.

    The sparse half (:func:`solve_sparse`) yields poses + a sparse cloud + ``transforms.json``. When
    ``dense`` and at least two views registered, :func:`solve_dense` depth-maps + fuses the registered
    views into a coloured oriented cloud (``report.dense_points`` = its size; ``dense_ply=None`` when
    that is zero — SPEC-13 §7). ``**sparse_kwargs`` are forwarded to :func:`solve_sparse` (``K``,
    ``exif_images``, ``matching``, ``max_features``, ``seed``, ``self_calibrate``, ``image_names``, …).

    Density controls: ``max_dense_points`` caps the fused cloud; ``min_views``/``rel_depth_tol``/
    ``normal_dot`` tune the fusion gate (→ :func:`solve_dense`). Resolution decoupling: pass
    ``dense_images`` (a list parallel to ``images``, higher-resolution) to densify at full input
    resolution while registering on the robust reduced-res ``images`` — extrinsics are
    resolution-free, so only ``K`` scales, and ``dense_K`` is auto-derived from the resolution ratio
    when omitted (pass it explicitly to override). Both default to ``None`` (dense runs at the sparse
    resolution, unchanged).
    """
    res = solve_sparse(images, **sparse_kwargs)
    report = dict(res.report)
    reg = res.registered
    dense_ply: str | None = None
    report["dense"] = dense
    report["dense_points"] = 0

    if dense and len(reg) >= 2:
        src_imgs = dense_images if dense_images is not None else images
        if dense_K is not None:
            dense_KK = np.asarray(dense_K, dtype=np.float64)
        elif dense_images is not None:
            # Scale the sparse K to the dense resolution — extrinsics are resolution-free, only K
            # scales. Ratio from the actual pixel heights; principal point scaled pixel-centre-consistent.
            ratio = np.asarray(src_imgs[reg[0]]).shape[0] / np.asarray(images[reg[0]]).shape[0]
            dense_KK = res.K.copy()
            dense_KK[0, 0] *= ratio
            dense_KK[1, 1] *= ratio
            dense_KK[0, 2] = (res.K[0, 2] + 0.5) * ratio - 0.5
            dense_KK[1, 2] = (res.K[1, 2] + 0.5) * ratio - 0.5
        else:
            dense_KK = res.K
        imgs_arr = np.stack([np.asarray(src_imgs[v])[:, :, :3] for v in reg], axis=0)  # (N,H,W,3) uint8
        poses_arr = np.stack([res.poses_w2c[v] for v in reg], axis=0)  # (N,3,4) normalized
        dense_ply, dense_points, swept = solve_dense(
            imgs_arr, poses_arr, res.points3d, dense_KK, max_dense_points=max_dense_points,
            min_views=min_views, rel_depth_tol=rel_depth_tol, normal_dot=normal_dot,
        )
        report["dense_points"] = dense_points
        report["dense_views_swept"] = swept

    return SolveResult(
        transforms_json=res.transforms_json,
        sparse_ply=res.sparse_ply,
        dense_ply=dense_ply,
        images_undistorted=None,
        report=report,
    )
