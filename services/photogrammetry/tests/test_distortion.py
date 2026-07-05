"""Tests for app/core/distortion.py — Brown-Conrady distort/undistort (P6.2, strict TDD).

The strict correctness gate is the self-consistent distort -> undistort point round-trip
(< 1e-6 px). OpenCV (`cv2`) is used ONLY here as a parity oracle (D-1 — never imported by app/):
- `cv2.undistortPoints` vs our `undistort_points` (matching iteration budget),
- `cv2.undistort`   vs our `undistort_image` (PSNR > 40 dB on a synthetic distorted image).

All test data is built inline (a K matrix + a pixel grid) — no dependency on tests/synthetic.py.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.core import distortion


# --- inline fixtures ------------------------------------------------------------------------------

def _K(fx=1000.0, fy=1000.0, cx=960.0, cy=540.0):
    return np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]], dtype=np.float64)


# A mild-to-moderate barrel (|k1| in the ~0.1–0.3 range so the fixed-point inverse converges to
# machine precision even at the image corners, which are the max-radius / worst-case points).
_DIST = np.array([-0.25, 0.08, 0.0006, -0.0006], dtype=np.float64)  # k1, k2, p1, p2
_W, _H = 1920, 1080


def _pixel_grid(w=_W, h=_H, n=9):
    us = np.linspace(0.0, w - 1, n)
    vs = np.linspace(0.0, h - 1, n)
    U, V = np.meshgrid(us, vs)
    return np.stack([U.ravel(), V.ravel()], axis=1)


def _pix_to_norm(pts_pix, K):
    x = (pts_pix[:, 0] - K[0, 2]) / K[0, 0]
    y = (pts_pix[:, 1] - K[1, 2]) / K[1, 1]
    return np.stack([x, y], axis=1)


def _norm_to_pix(pts_norm, K):
    u = K[0, 0] * pts_norm[:, 0] + K[0, 2]
    v = K[1, 1] * pts_norm[:, 1] + K[1, 2]
    return np.stack([u, v], axis=1)


def _psnr(a, b, peak=255.0):
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    if mse <= 0.0:
        return float("inf")
    return 10.0 * np.log10(peak * peak / mse)


def _synthetic_image(w=320, h=240):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    img = 127.5 + 60.0 * np.sin(2 * np.pi * xx / w * 3.0) + 50.0 * np.cos(2 * np.pi * yy / h * 2.0)
    img = img + 40.0 * (xx / w)
    return img.astype(np.float32)


def _synthetic_rgb_uint8(w=320, h=240):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    ch0 = 127.5 + 60.0 * np.sin(2 * np.pi * xx / w * 3.0) + 40.0 * (xx / w)
    ch1 = 120.0 + 50.0 * np.cos(2 * np.pi * yy / h * 2.0)
    ch2 = 100.0 + 30.0 * np.sin(2 * np.pi * (xx + yy) / w * 2.0)
    return np.clip(np.stack([ch0, ch1, ch2], axis=2), 0.0, 255.0).astype(np.uint8)


# --- round-trip: the strict correctness gate ------------------------------------------------------

def test_distort_undistort_point_roundtrip_subpixel():
    K = _K()
    ideal_pix = _pixel_grid()                       # ideal (undistorted) pixel positions
    ideal_norm = _pix_to_norm(ideal_pix, K)
    dist_norm = distortion.distort_points(ideal_norm, _DIST)
    dist_pix = _norm_to_pix(dist_norm, K)           # where the ideal point actually images
    recovered_pix = distortion.undistort_points(dist_pix, K, _DIST, num_iters=20)
    err = np.linalg.norm(recovered_pix - ideal_pix, axis=1)
    assert err.max() < 1e-6, f"max round-trip error {err.max()} px (worst at corners)"


def test_roundtrip_holds_at_corners():
    K = _K()
    corners_pix = np.array(
        [[0.0, 0.0], [_W - 1, 0.0], [0.0, _H - 1], [_W - 1, _H - 1]], dtype=np.float64
    )
    corners_norm = _pix_to_norm(corners_pix, K)
    dist_pix = _norm_to_pix(distortion.distort_points(corners_norm, _DIST), K)
    recovered = distortion.undistort_points(dist_pix, K, _DIST, num_iters=20)
    assert np.allclose(recovered, corners_pix, atol=1e-6)


# --- OpenCV parity (oracle; cv2 is test-only) -----------------------------------------------------

def test_opencv_undistort_points_parity():
    cv2 = pytest.importorskip("cv2")
    K = _K()
    ideal_pix = _pixel_grid()
    dist_pix = _norm_to_pix(distortion.distort_points(_pix_to_norm(ideal_pix, K), _DIST), K)

    # cv2.undistortPoints defaults to ~5 fixed-point iterations; match its budget so the comparison
    # is apples-to-apples (the strict convergence check is the round-trip test above).
    mine = distortion.undistort_points(dist_pix, K, _DIST, num_iters=5)

    src = dist_pix.astype(np.float32).reshape(-1, 1, 2)
    cv_out = cv2.undistortPoints(src, K, _DIST, P=K).reshape(-1, 2)
    dev = np.linalg.norm(mine - cv_out, axis=1)
    assert dev.max() < 1e-3, f"cv2 parity max deviation {dev.max()} px"


def test_opencv_undistort_image_parity_psnr():
    cv2 = pytest.importorskip("cv2")
    fx = fy = 220.0
    K = _K(fx, fy, 159.5, 119.5)
    dist = np.array([-0.28, 0.10, 0.0008, -0.0006], dtype=np.float64)
    img = _synthetic_image()

    mine, K_new = distortion.undistort_image(img, K, dist)
    cv_out = cv2.undistort(img, K, dist)

    assert mine.shape == img.shape
    assert np.allclose(K_new, K)  # keep-it-simple contract: post-undistort K == K (cv2 default)
    psnr = _psnr(mine, cv_out)
    assert psnr > 40.0, f"PSNR vs cv2.undistort was {psnr} dB"


def test_opencv_undistort_image_parity_rgb_uint8():
    # The real FR-4 consumer path: multi-channel uint8 frames (base64-JPEG decodes to RGB uint8).
    cv2 = pytest.importorskip("cv2")
    K = _K(220.0, 220.0, 159.5, 119.5)
    dist = np.array([-0.28, 0.10, 0.0008, -0.0006], dtype=np.float64)
    img = _synthetic_rgb_uint8()

    mine, _ = distortion.undistort_image(img, K, dist)
    cv_out = cv2.undistort(img, K, dist)

    assert mine.shape == img.shape and mine.dtype == img.dtype  # (H, W, 3) uint8 preserved
    psnr = _psnr(mine, cv_out)
    assert psnr > 40.0, f"PSNR vs cv2.undistort (RGB uint8) was {psnr} dB"


def test_k3_coefficient_roundtrip_and_parity():
    # Prove the k3 (5-coefficient) extension: strict round-trip + cv2 model agreement.
    cv2 = pytest.importorskip("cv2")
    K = _K()
    dist5 = np.array([-0.25, 0.08, 0.0006, -0.0006, 0.02], dtype=np.float64)
    ideal_pix = _pixel_grid()
    dist_pix = _norm_to_pix(distortion.distort_points(_pix_to_norm(ideal_pix, K), dist5), K)

    recovered = distortion.undistort_points(dist_pix, K, dist5, num_iters=20)
    assert np.linalg.norm(recovered - ideal_pix, axis=1).max() < 1e-6

    mine = distortion.undistort_points(dist_pix, K, dist5, num_iters=5)
    cv_out = cv2.undistortPoints(dist_pix.astype(np.float32).reshape(-1, 1, 2), K, dist5, P=K)
    dev = np.linalg.norm(mine - cv_out.reshape(-1, 2), axis=1)
    assert dev.max() < 1e-3, f"k3 cv2 parity max deviation {dev.max()} px"


# --- zero-coefficient no-op -----------------------------------------------------------------------

def test_zero_coeff_is_identity_points():
    K = _K()
    zero = np.zeros(4, dtype=np.float64)
    pts_norm = _pix_to_norm(_pixel_grid(), K)
    assert np.allclose(distortion.distort_points(pts_norm, zero), pts_norm, atol=0.0)

    pts_pix = _pixel_grid()
    assert np.allclose(distortion.undistort_points(pts_pix, K, zero), pts_pix, atol=1e-9)


def test_zero_coeff_is_identity_image():
    K = _K(300.0, 300.0, 160.0, 120.0)
    zero = np.zeros(4, dtype=np.float64)
    img = _synthetic_image()
    out, K_new = distortion.undistort_image(img, K, zero)
    assert np.array_equal(out, img)
    assert np.allclose(K_new, K)


# --- determinism ----------------------------------------------------------------------------------

def test_determinism_points_bitwise():
    K = _K()
    pts = _norm_to_pix(distortion.distort_points(_pix_to_norm(_pixel_grid(), K), _DIST), K)
    a = distortion.undistort_points(pts, K, _DIST, num_iters=20)
    b = distortion.undistort_points(pts, K, _DIST, num_iters=20)
    assert np.array_equal(a, b)


def test_determinism_image_bitwise():
    K = _K(220.0, 220.0, 159.5, 119.5)
    img = _synthetic_image()
    a, _ = distortion.undistort_image(img, K, _DIST)
    b, _ = distortion.undistort_image(img, K, _DIST)
    assert np.array_equal(a, b)
