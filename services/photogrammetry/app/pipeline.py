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

from dataclasses import dataclass

import numpy as np

from app.core.features import detect_and_describe
from app.core.match import match_image_set
from app.emit import emit_transforms_json, write_ply_sparse
from app.exif import intrinsics_prior
from app.normalize import normalize_scene
from app.sfm import build_tracks, reconstruct, select_init_pair


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

    # --- matching + tracks --------------------------------------------------------------------
    pair_matches = match_image_set(descriptors, schedule=matching, window=window, ratio=ratio)
    pair_matches = [(i, j, m) for (i, j, m) in pair_matches if m.shape[0] >= 8]
    tracks = build_tracks(pair_matches, n)

    if not pair_matches or not tracks:
        raise ValueError("no usable matches/tracks — the images may not overlap or lack texture")

    # --- reconstruct ---------------------------------------------------------------------------
    init = select_init_pair(pair_matches, keypoints, K)
    sfm = reconstruct(tracks, keypoints, K, init_pair=init, image_names=names, seed=seed,
                      fix_intrinsics=not self_calibrate)

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
        norm.poses_w2c, K, w, h, reg_names, undistort=True,
        applied_transform=norm.applied_transform,
    )
    import io
    buf = io.StringIO()
    colors = np.full((pts_arr.shape[0], 3), 200, dtype=np.int64)
    write_ply_sparse(buf, norm.points3d, colors)
    sparse_ply = buf.getvalue()

    # --- report --------------------------------------------------------------------------------
    track_lengths = [sum(1 for v in tracks[tid] if v in sfm.poses_w2c) for tid in tids]
    report = {
        "images_total": n,
        "images_registered": len(reg),
        "unregistered_names": sfm.unregistered_names,
        "sparse_points": len(tids),
        "mean_reprojection_error_px": sfm.mean_reproj,
        "mean_track_length": float(np.mean(track_lengths)) if track_lengths else 0.0,
        "matching": matching,
        "seed": seed,
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
