"""Brown-Conrady lens distortion: forward distortion, iterative inverse, and image undistortion.

Model (OpenCV / Brown-Conrady) with radial ``k1, k2`` (extendable to ``k3``) and tangential
``p1, p2`` coefficients, ordered ``[k1, k2, p1, p2, k3]`` to match the OpenCV coefficient vector.
Given an *ideal* normalized image coordinate ``(x, y)`` with ``r^2 = x^2 + y^2``::

    x_d = x * (1 + k1 r^2 + k2 r^4 + k3 r^6) + 2 p1 x y + p2 (r^2 + 2 x^2)
    y_d = y * (1 + k1 r^2 + k2 r^4 + k3 r^6) + p1 (r^2 + 2 y^2) + 2 p2 x y

The inverse (undistort) has no closed form; it is solved by the OpenCV fixed-point iteration with a
fixed iteration budget (deterministic). Image undistortion builds an inverse map (for each output
pixel, find the distorted source location via the forward model) and bilinearly resamples with a
zero constant border — the ``initUndistortRectifyMap`` + ``remap`` composition ``cv2.undistort`` uses.

Numerics (docs/adr/0013 D-9): pure float64 numpy on the CPU — deterministic, element-wise, MLX-free.
OpenCV is a *test-only* oracle (D-1) and is never imported here.

Algorithm reimplemented (no code copied) with attribution from kornia (Apache-2.0):
``kornia/geometry/calibration/distort.py::distort_points`` and
``kornia/geometry/calibration/undistort.py::{undistort_points, undistort_image}``, which in turn
follow OpenCV's ``distortion_model.hpp`` / ``undistort.dispatch.cpp``.
"""

from __future__ import annotations

import numpy as np

__all__ = ["distort_points", "undistort_points", "undistort_image"]


def _unpack_dist(dist):
    """Return ``(k1, k2, p1, p2, k3)`` from a 4- or 5-element coefficient vector."""
    d = np.asarray(dist, dtype=np.float64).ravel()
    if d.size not in (4, 5):
        raise ValueError(f"dist must have 4 (k1,k2,p1,p2) or 5 (…,k3) coefficients; got {d.size}")
    k1, k2, p1, p2 = d[0], d[1], d[2], d[3]
    k3 = d[4] if d.size == 5 else 0.0
    return float(k1), float(k2), float(p1), float(p2), float(k3)


def _as_points(points):
    """Validate/copy an ``(N, 2)`` float64 array of points."""
    p = np.asarray(points, dtype=np.float64)
    if p.ndim != 2 or p.shape[-1] != 2:
        raise ValueError(f"points must have shape (N, 2); got {p.shape}")
    return p


def distort_points(points_norm, dist):
    """Apply Brown-Conrady distortion to *normalized* image coordinates.

    Args:
        points_norm: ``(N, 2)`` ideal (pinhole) normalized coordinates ``x = (u - cx)/fx`` etc.
        dist: ``[k1, k2, p1, p2]`` or ``[k1, k2, p1, p2, k3]``.

    Returns:
        ``(N, 2)`` distorted normalized coordinates.
    """
    pts = _as_points(points_norm)
    k1, k2, p1, p2, k3 = _unpack_dist(dist)
    x = pts[:, 0]
    y = pts[:, 1]
    r2 = x * x + y * y
    r4 = r2 * r2
    r6 = r4 * r2
    radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6
    xd = x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
    yd = y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
    return np.stack([xd, yd], axis=1)


def undistort_points(points_pix, K, dist, num_iters: int = 20, new_K=None):
    """Undistort *distorted pixel* coordinates via the OpenCV fixed-point inverse.

    Args:
        points_pix: ``(N, 2)`` distorted pixel coordinates (as observed in the raw image).
        K: ``(3, 3)`` intrinsic matrix of the distorted image.
        dist: ``[k1, k2, p1, p2[, k3]]``.
        num_iters: fixed iteration budget for the inverse (deterministic). 20 reaches machine
            precision for barrel distortion across a full frame.
        new_K: intrinsic matrix to reproject the undistorted points with. Defaults to ``K``.

    Returns:
        ``(N, 2)`` undistorted pixel coordinates in the ``new_K`` (default ``K``) frame.
    """
    if num_iters < 1:
        raise ValueError(f"num_iters must be >= 1; got {num_iters}")
    pts = _as_points(points_pix)
    K = np.asarray(K, dtype=np.float64)
    if K.shape != (3, 3):
        raise ValueError(f"K must have shape (3, 3); got {K.shape}")
    new_K = K if new_K is None else np.asarray(new_K, dtype=np.float64)
    if new_K.shape != (3, 3):
        raise ValueError(f"new_K must have shape (3, 3); got {new_K.shape}")

    k1, k2, p1, p2, k3 = _unpack_dist(dist)
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]

    # Distorted normalized coordinates: K^-1 [u, v, 1]^T.
    x0 = (pts[:, 0] - cx) / fx
    y0 = (pts[:, 1] - cy) / fy

    x = x0.copy()
    y = y0.copy()
    for _ in range(num_iters):
        r2 = x * x + y * y
        r4 = r2 * r2
        r6 = r4 * r2
        inv_radial = 1.0 / (1.0 + k1 * r2 + k2 * r4 + k3 * r6)
        delta_x = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
        delta_y = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
        x = (x0 - delta_x) * inv_radial
        y = (y0 - delta_y) * inv_radial

    u = new_K[0, 0] * x + new_K[0, 2]
    v = new_K[1, 1] * y + new_K[1, 2]
    return np.stack([u, v], axis=1)


def _bilinear_sample(src, map_x, map_y):
    """Bilinearly sample ``src`` (H, W, C) at float coords, zero constant border (per tap)."""
    h, w = src.shape[:2]
    x0 = np.floor(map_x).astype(np.intp)
    y0 = np.floor(map_y).astype(np.intp)
    ax = (map_x - x0)[..., None]
    ay = (map_y - y0)[..., None]

    def tap(xi, yi):
        valid = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
        xc = np.clip(xi, 0, w - 1)
        yc = np.clip(yi, 0, h - 1)
        vals = src[yc, xc]  # (H, W, C)
        return np.where(valid[..., None], vals, 0.0)

    return (
        tap(x0, y0) * (1.0 - ax) * (1.0 - ay)
        + tap(x0 + 1, y0) * ax * (1.0 - ay)
        + tap(x0, y0 + 1) * (1.0 - ax) * ay
        + tap(x0 + 1, y0 + 1) * ax * ay
    )


def undistort_image(image, K, dist):
    """Undistort an image by inverse-map bilinear resampling.

    For each output pixel ``(u, v)`` the ideal normalized coordinate ``K_new^-1 [u, v, 1]`` is
    distorted by the forward model, mapped to a source pixel through ``K``, and bilinearly sampled
    (zero constant border). ``K_new`` is kept equal to ``K`` (documented: the emitted intrinsics do
    not change scale/offset), matching ``cv2.undistort``'s default ``newCameraMatrix = K``.

    Args:
        image: ``(H, W)`` or ``(H, W, C)`` array. Integer images are rounded on output.
        K: ``(3, 3)`` intrinsic matrix.
        dist: ``[k1, k2, p1, p2[, k3]]``.

    Returns:
        ``(undistorted_image, K_new)`` — the resampled image (same shape and dtype as ``image``)
        and the post-undistortion intrinsics ``K_new == K``.
    """
    img = np.asarray(image)
    if img.ndim not in (2, 3):
        raise ValueError(f"image must be (H, W) or (H, W, C); got shape {img.shape}")
    K = np.asarray(K, dtype=np.float64)
    if K.shape != (3, 3):
        raise ValueError(f"K must have shape (3, 3); got {K.shape}")

    was_2d = img.ndim == 2
    src = img.astype(np.float64)
    if was_2d:
        src = src[..., None]
    h, w = src.shape[:2]

    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    us, vs = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    # K_new == K, so the ideal normalized grid uses the same intrinsics.
    x = (us - cx) / fx
    y = (vs - cy) / fy
    grid = np.stack([x.ravel(), y.ravel()], axis=1)
    dist_norm = distort_points(grid, dist)
    map_x = (fx * dist_norm[:, 0] + cx).reshape(h, w)
    map_y = (fy * dist_norm[:, 1] + cy).reshape(h, w)

    out = _bilinear_sample(src, map_x, map_y)
    if was_2d:
        out = out[..., 0]

    if np.issubdtype(img.dtype, np.integer):
        info = np.iinfo(img.dtype)
        out = np.clip(np.rint(out), info.min, info.max).astype(img.dtype)
    else:
        out = out.astype(img.dtype)

    return out, K.copy()
