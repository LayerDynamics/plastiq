"""Emission contracts — ``transforms.json`` + ASCII PLY writers (SPEC-13 §6.2/§6.3, plan P6.3).

The producer boundary of the pipeline. Two artifacts leave the service:

  * a ``transforms.json`` string in the **nerfstudio convention** (FR-3): the ``colmap_to_json`` field
    set (``w,h,fl_x,fl_y,cx,cy,k1,k2,p1,p2,camera_model,frames[],applied_transform``), with camera
    poses converted from the internal OpenCV world→camera ``[R|t]`` to **OpenGL camera-to-world**
    (``ref/nerfstudio/nerfstudio/process_data/colmap_utils.py:444-446``: ``c2w = inv(w2c)`` then
    ``c2w[0:3, 1:3] *= -1``). The ``[0,2,1,3]`` world permutation nerfstudio applies is **not** done
    here — ``normalize.py`` (D-5) already produces a +z-up world, and the normalization similarity is
    what ``applied_transform`` records (SPEC-13 §6.2);
  * ASCII PLY point clouds (§6.3): sparse ``x y z red green blue`` and dense
    ``x y z nx ny nz red green blue`` — the exact header property order
    ``packages/capture/src/pointcloud.ts`` reads by position.

Distortion is **zeroed** in the emitted intrinsics when ``undistort=True`` (D-6: the frames are
returned already undistorted); with ``undistort=False`` the calibrated Brown-Conrady coefficients
ride on the wire for external consumers.

MLX-free by construction (numpy + stdlib only): this module is on the CI import seam (NFR-4) with
``normalize``/``exif``/``jobs``. It never imports ``mlx`` or ``cv2`` (D-1). Deterministic — no RNG,
no wall-clock.
"""

from __future__ import annotations

import json
from typing import IO, Optional, Sequence, Union

import numpy as np

__all__ = ["emit_transforms_json", "write_ply_sparse", "write_ply_dense"]

# Enough significant digits to round-trip float32-scale geometry through a text reader without loss.
_FLOAT_FMT = "{:.9g}"

PathOrBuffer = Union[str, "IO[str]"]


def _pose_to_opengl_c2w(pose_w2c: np.ndarray) -> np.ndarray:
    """Internal OpenCV world→camera ``[R|t]`` → OpenGL camera-to-world 4×4.

    ``c2w = inv([[R, t], [0, 0, 0, 1]])`` then flip the camera y/z axis columns
    (``c2w[0:3, 1:3] *= -1``) — the ``colmap_utils.py:444-446`` conversion, minus the world
    permutation (SPEC-13 §6.2)."""
    w2c = np.eye(4, dtype=np.float64)
    w2c[:3, :4] = np.asarray(pose_w2c, dtype=np.float64)[:3, :4]
    c2w = np.linalg.inv(w2c)
    c2w[0:3, 1:3] *= -1.0
    return c2w


def emit_transforms_json(
    poses_w2c: np.ndarray,
    K: np.ndarray,
    width: int,
    height: int,
    image_names: Sequence[str],
    *,
    dist: Optional[Sequence[float]] = None,
    undistort: bool = True,
    applied_transform: Optional[np.ndarray] = None,
    reproj_errors: Optional[Sequence[float]] = None,
) -> str:
    """Build the SPEC-13 §6.2 ``transforms.json`` and return it as a JSON string.

    Args:
        poses_w2c: ``(N, 3, 4)`` (or ``(N, 4, 4)``) internal OpenCV world→camera ``[R|t]`` poses.
        K: ``(3, 3)`` shared pinhole intrinsics (``fl_x=K[0,0]``, ``fl_y=K[1,1]``, ``cx=K[0,2]``,
            ``cy=K[1,2]``).
        width, height: emitted image size in pixels (``w``/``h``).
        image_names: ``N`` upload filenames; ``frames[i].file_path = "./images/<name>"`` (the panel's
            filename pairing).
        dist: optional calibrated Brown-Conrady ``[k1, k2, p1, p2(, k3)]``; only the first four are
            emitted (§6.2 field set). Ignored when ``undistort=True``.
        undistort: when ``True`` (D-6 default) the frames are already undistorted, so ``k1..p2`` are
            **zeroed**; when ``False`` the calibrated ``dist`` coefficients are emitted (zeros if
            ``dist`` is ``None``).
        applied_transform: optional ``(3, 4)`` forward normalization similarity (D-5) — emitted as
            ``applied_transform`` when given, omitted otherwise.
        reproj_errors: optional ``N`` per-frame mean reprojection errors (px) — emitted as each
            frame's ``reproj_error_px`` when given (consumers ignore unknown keys).

    Returns:
        The ``transforms.json`` content as a ``str``.
    """
    poses = np.asarray(poses_w2c, dtype=np.float64)
    if poses.ndim != 3 or poses.shape[1] < 3 or poses.shape[2] != 4:
        raise ValueError(f"poses_w2c must have shape (N, 3, 4) or (N, 4, 4); got {poses.shape}")
    n = poses.shape[0]
    names = list(image_names)
    if len(names) != n:
        raise ValueError(f"image_names length ({len(names)}) must match poses ({n})")
    if reproj_errors is not None and len(reproj_errors) != n:
        raise ValueError(f"reproj_errors length ({len(reproj_errors)}) must match poses ({n})")

    K = np.asarray(K, dtype=np.float64)
    if K.shape != (3, 3):
        raise ValueError(f"K must have shape (3, 3); got {K.shape}")

    if undistort or dist is None:
        k1 = k2 = p1 = p2 = 0.0
    else:
        coeffs = np.asarray(dist, dtype=np.float64).ravel()
        if coeffs.shape[0] < 4:
            raise ValueError(f"dist must have at least 4 coefficients [k1,k2,p1,p2]; got {coeffs.shape}")
        k1, k2, p1, p2 = (float(coeffs[0]), float(coeffs[1]), float(coeffs[2]), float(coeffs[3]))

    out: dict = {
        "w": int(width),
        "h": int(height),
        "fl_x": float(K[0, 0]),
        "fl_y": float(K[1, 1]),
        "cx": float(K[0, 2]),
        "cy": float(K[1, 2]),
        "k1": k1,
        "k2": k2,
        "p1": p1,
        "p2": p2,
        "camera_model": "OPENCV",
    }

    frames = []
    for i in range(n):
        c2w = _pose_to_opengl_c2w(poses[i])
        frame: dict = {
            "file_path": f"./images/{names[i]}",
            "transform_matrix": c2w.tolist(),
        }
        if reproj_errors is not None:
            frame["reproj_error_px"] = float(reproj_errors[i])
        frames.append(frame)
    out["frames"] = frames

    if applied_transform is not None:
        applied = np.asarray(applied_transform, dtype=np.float64)
        if applied.shape != (3, 4):
            raise ValueError(f"applied_transform must have shape (3, 4); got {applied.shape}")
        out["applied_transform"] = applied.tolist()

    return json.dumps(out, indent=2)


# --- ASCII PLY writers ----------------------------------------------------------------------------


def _open_target(path_or_buffer: PathOrBuffer):
    """Return ``(file_object, should_close)``. A file-like object (has ``write``) is used as-is;
    anything else is treated as a path and opened for text writing."""
    if hasattr(path_or_buffer, "write"):
        return path_or_buffer, False
    return open(path_or_buffer, "w", encoding="utf-8"), True  # noqa: SIM115 — closed by caller below


def _validate_cloud(points: np.ndarray, colors: np.ndarray, normals: Optional[np.ndarray] = None):
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise ValueError(f"points must have shape (N, 3); got {pts.shape}")
    n = pts.shape[0]
    cols = np.asarray(colors)
    if cols.shape != (n, 3):
        raise ValueError(f"colors must have shape (N, 3) matching points; got {cols.shape}")
    cols = np.clip(np.rint(cols.astype(np.float64)), 0, 255).astype(np.int64)
    nrm = None
    if normals is not None:
        nrm = np.asarray(normals, dtype=np.float64)
        if nrm.shape != (n, 3):
            raise ValueError(f"normals must have shape (N, 3) matching points; got {nrm.shape}")
    return pts, cols, nrm


def _write_ply(path_or_buffer: PathOrBuffer, pts, cols, nrm) -> None:
    n = pts.shape[0]
    lines = ["ply", "format ascii 1.0", f"element vertex {n}"]
    lines += ["property float x", "property float y", "property float z"]
    if nrm is not None:
        lines += ["property float nx", "property float ny", "property float nz"]
    lines += ["property uchar red", "property uchar green", "property uchar blue"]
    lines.append("end_header")

    for i in range(n):
        row = [_FLOAT_FMT.format(pts[i, 0]), _FLOAT_FMT.format(pts[i, 1]), _FLOAT_FMT.format(pts[i, 2])]
        if nrm is not None:
            row += [
                _FLOAT_FMT.format(nrm[i, 0]),
                _FLOAT_FMT.format(nrm[i, 1]),
                _FLOAT_FMT.format(nrm[i, 2]),
            ]
        row += [str(int(cols[i, 0])), str(int(cols[i, 1])), str(int(cols[i, 2]))]
        lines.append(" ".join(row))

    text = "\n".join(lines) + "\n"
    target, should_close = _open_target(path_or_buffer)
    try:
        target.write(text)
    finally:
        if should_close:
            target.close()


def write_ply_sparse(path_or_buffer: PathOrBuffer, points: np.ndarray, colors: np.ndarray) -> None:
    """Write a sparse ASCII PLY ``x y z red green blue`` (SPEC-13 §6.3).

    Args:
        path_or_buffer: a filesystem path or an already-open text file object.
        points: ``(N, 3)`` xyz coordinates (normalized world frame).
        colors: ``(N, 3)`` RGB in ``[0, 255]`` (rounded + clipped to ``uchar``).
    """
    pts, cols, _ = _validate_cloud(points, colors)
    _write_ply(path_or_buffer, pts, cols, None)


def write_ply_dense(
    path_or_buffer: PathOrBuffer,
    points: np.ndarray,
    normals: np.ndarray,
    colors: np.ndarray,
) -> None:
    """Write a dense oriented ASCII PLY ``x y z nx ny nz red green blue`` (SPEC-13 §6.3).

    The ``nx/ny/nz`` properties are what ``packages/capture/src/pointcloud.ts`` reads to recover the
    per-point normals the capture ``/capture`` endpoint requires.

    Args:
        path_or_buffer: a filesystem path or an already-open text file object.
        points: ``(N, 3)`` xyz coordinates (normalized world frame).
        normals: ``(N, 3)`` per-point unit normals.
        colors: ``(N, 3)`` RGB in ``[0, 255]`` (rounded + clipped to ``uchar``).
    """
    pts, cols, nrm = _validate_cloud(points, colors, normals)
    _write_ply(path_or_buffer, pts, cols, nrm)
