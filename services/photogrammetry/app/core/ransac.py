"""Seeded MSAC robust estimation for the two-view / resection models (P3.1).

A single generic MSAC (M-estimator SAmple Consensus, Torr & Zisserman 2000) driver, ``_msac``, plus
three per-model wrappers that plug in a minimal solver + a geometric residual:

- :func:`ransac_fundamental` — minimal sample 8, Sampson-distance scoring, final refit on inliers.
- :func:`ransac_essential`  — minimal sample 5 (Nistér, up to 10 candidate E per sample), Sampson
  scoring on the induced pixel fundamental ``F = K2⁻ᵀ E K1⁻¹``; the pose is finalized by
  cheirality (:func:`app.core.epipolar.recover_pose`) on the recovered inliers.
- :func:`ransac_pnp`        — minimal sample 6 (DLT-PnP), reprojection-error scoring, final
  Levenberg-Marquardt refine on inliers.

**MSAC cost.** Unlike plain RANSAC (which counts inliers), MSAC scores a model by the *truncated
quadratic* ``Σ min(rᵢ, T)²`` over all correspondences: an inlier contributes its squared residual, an
outlier the constant ``T²``. Lower cost is better — this rewards models that fit their inliers
*tightly*, not merely numerously, so ties between equal-inlier-count models break toward the
geometrically better one. Inliers are ``rᵢ < T`` (the threshold ``T`` is in pixels for every model).

**Adaptive early stop.** After each new best model the required iteration count is refreshed to
``N = log(1 − confidence) / log(1 − wᵐ)`` (``w`` = current best inlier ratio, ``m`` = minimal-sample
size) and the loop stops once it is reached — capped by the fixed ``max_iters`` budget so a bad ratio
never runs away.

**Determinism (SPEC-13 D-10).** Each wrapper builds exactly one ``numpy.random.Generator`` seeded by
``np.random.Generator(np.random.PCG64(seed))`` and threads it through every minimal-sample draw; there
is no global ``np.random.seed`` and no wall-clock. Same input + same seed → byte-identical masks.

Numerics (docs/adr/0013 D-9): pure float64 numpy/scipy on the CPU — the sparse/combinatorial solver
tier, MLX-free. OpenCV is a *test-only* oracle (D-1) and is never imported here.

Algorithm reimplemented (no code copied) with attribution from kornia (Apache-2.0):
``kornia/geometry/ransac.py::RANSAC`` (the MSAC loop / adaptive-stop structure) — which follows
Fischler & Bolles 1981 (RANSAC) and Torr & Zisserman 2000 (MSAC).
"""

from __future__ import annotations

import math
from typing import Callable

import numpy as np

from app.core import epipolar, pnp

__all__ = ["ransac_fundamental", "ransac_essential", "ransac_pnp"]


def _adaptive_num_iters(n_inliers: int, n_total: int, sample_size: int, confidence: float) -> int:
    """RANSAC/MSAC adaptive iteration count ``N = log(1−conf) / log(1−wᵐ)`` (Fischler & Bolles 1981).

    Returns 1 when the sample is already essentially certain and a large value (later capped by the
    fixed budget) when the current inlier ratio is too low to justify stopping.
    """
    if n_total <= sample_size or n_inliers >= n_total:
        return 1
    if n_inliers <= sample_size or confidence <= 0.0:
        return 1_000_000
    if confidence >= 1.0:
        return 1_000_000
    w = n_inliers / n_total
    denom = 1.0 - w ** sample_size
    if denom <= 0.0:
        return 1
    num = math.log(max(1.0 - confidence, 1e-12))
    den = math.log(max(denom, 1e-12))
    if den >= 0.0:
        return 1_000_000
    return max(1, int(math.ceil(num / den)))


def _msac(
    n_points: int,
    sample_size: int,
    fit_fn: Callable[[np.ndarray], list],
    residual_fn: Callable[[object], np.ndarray],
    rng: np.random.Generator,
    threshold: float,
    max_iters: int,
    confidence: float,
):
    """Generic seeded MSAC driver.

    Args:
        n_points: number of correspondences.
        sample_size: minimal-sample size ``m`` for the model.
        fit_fn: ``sample_indices → list of candidate models`` (empty list ⇒ degenerate sample, skipped).
        residual_fn: ``model → (N,) non-negative per-point geometric residuals`` (may contain ``inf``).
        rng: the single seeded generator threaded through all minimal-sample draws (D-10).
        threshold: inlier threshold ``T`` (pixels); MSAC truncates the squared residual at ``T²``.
        max_iters: fixed iteration-budget cap.
        confidence: target confidence for the adaptive early stop.

    Returns:
        ``(best_model, best_mask (N,) bool, best_cost float)``; ``best_model`` is ``None`` if no model
        could be fit (fewer than ``sample_size`` points, or every sample degenerate).
    """
    best_cost = math.inf
    best_model = None
    best_mask = np.zeros(n_points, dtype=bool)
    if n_points < sample_size:
        return best_model, best_mask, best_cost

    iters = int(max_iters)
    i = 0
    while i < iters:
        sample = rng.choice(n_points, size=sample_size, replace=False)
        for model in fit_fn(sample):
            res = np.asarray(residual_fn(model), dtype=np.float64)
            clamped = np.minimum(res, threshold)
            cost = float(np.sum(clamped * clamped))
            if cost < best_cost:
                best_cost = cost
                best_model = model
                best_mask = res < threshold
                n_inl = int(best_mask.sum())
                iters = min(iters, _adaptive_num_iters(n_inl, n_points, sample_size, confidence))
        i += 1
    return best_model, best_mask, best_cost


def _msac_cost(res: np.ndarray, threshold: float) -> float:
    clamped = np.minimum(np.asarray(res, dtype=np.float64), threshold)
    return float(np.sum(clamped * clamped))


def ransac_fundamental(points1, points2, *, seed: int = 0, threshold: float = 1.0,
                       max_iters: int = 1000, confidence: float = 0.999):
    """Robustly estimate the fundamental matrix from contaminated correspondences via MSAC.

    Args:
        points1: ``(N, 2)`` points in image 1.
        points2: ``(N, 2)`` corresponding points in image 2.
        seed: RNG seed (one ``Generator`` threaded through all sampling — D-10).
        threshold: Sampson inlier threshold in pixels.
        max_iters: fixed iteration budget.
        confidence: adaptive early-stop confidence.

    Returns:
        ``(F (3, 3), inlier_mask (N,) bool)`` — ``F`` refit on the recovered inlier set.

    Raises:
        ValueError: if fewer than 8 correspondences are given or no model could be fit.
    """
    pts1 = np.asarray(points1, dtype=np.float64)
    pts2 = np.asarray(points2, dtype=np.float64)
    n = pts1.shape[0]
    rng = np.random.Generator(np.random.PCG64(seed))

    def fit(sample: np.ndarray) -> list:
        try:
            return [epipolar.find_fundamental(pts1[sample], pts2[sample])]
        except (ValueError, np.linalg.LinAlgError):
            return []

    def resid(F) -> np.ndarray:
        return epipolar.sampson_distance(F, pts1, pts2)

    F, mask, cost = _msac(n, 8, fit, resid, rng, threshold, max_iters, confidence)
    if F is None:
        raise ValueError("RANSAC could not fit a fundamental matrix (too few / degenerate points)")

    # Final refit on the inliers (local optimization): accept only if it does not worsen the cost.
    if int(mask.sum()) >= 8:
        try:
            F_ref = epipolar.find_fundamental(pts1[mask], pts2[mask])
            res_ref = epipolar.sampson_distance(F_ref, pts1, pts2)
            if _msac_cost(res_ref, threshold) <= cost:
                F, mask = F_ref, res_ref < threshold
        except (ValueError, np.linalg.LinAlgError):
            pass
    return F, mask


def ransac_essential(points1, points2, K1, K2, *, seed: int = 0, threshold: float = 1.0,
                     max_iters: int = 1000, confidence: float = 0.999):
    """Robustly estimate the essential matrix + relative pose from contaminated correspondences.

    Minimal sample 5 → Nistér candidates (:func:`app.core.epipolar.find_essential`); each candidate
    ``E`` is scored by the Sampson distance of the induced pixel fundamental ``F = K2⁻ᵀ E K1⁻¹`` so
    the threshold stays in pixels. The MSAC-best ``E`` and its inliers are then disambiguated into a
    physical ``(R, t)`` by cheirality (:func:`app.core.epipolar.recover_pose`).

    Args:
        points1: ``(N, 2)`` pixel points in image 1.
        points2: ``(N, 2)`` corresponding pixel points in image 2.
        K1, K2: ``(3, 3)`` intrinsics of camera 1 and camera 2.
        seed, threshold, max_iters, confidence: as :func:`ransac_fundamental`.

    Returns:
        ``(E (3, 3), R (3, 3), t (3,), inlier_mask (N,) bool)`` — ``t`` a unit translation direction.

    Raises:
        ValueError: if fewer than 5 correspondences are given or no model could be fit.
    """
    pts1 = np.asarray(points1, dtype=np.float64)
    pts2 = np.asarray(points2, dtype=np.float64)
    K1 = np.asarray(K1, dtype=np.float64)
    K2 = np.asarray(K2, dtype=np.float64)
    n = pts1.shape[0]
    rng = np.random.Generator(np.random.PCG64(seed))

    K1_inv = np.linalg.inv(K1)
    K2_inv_T = np.linalg.inv(K2).T

    def e_to_f(E: np.ndarray) -> np.ndarray:
        return K2_inv_T @ E @ K1_inv

    def fit(sample: np.ndarray) -> list:
        try:
            cands = epipolar.find_essential(pts1[sample], pts2[sample], K1, K2)  # (m, 3, 3)
        except (ValueError, np.linalg.LinAlgError):
            return []
        return [cands[k] for k in range(cands.shape[0])]

    def resid(E) -> np.ndarray:
        return epipolar.sampson_distance(e_to_f(E), pts1, pts2)

    E, mask, _ = _msac(n, 5, fit, resid, rng, threshold, max_iters, confidence)
    if E is None:
        raise ValueError("RANSAC could not fit an essential matrix (too few / degenerate points)")

    # Cheirality-disambiguate the pose on the recovered inliers (fall back to all points if too few).
    if int(mask.sum()) >= 5:
        R, t, _ = epipolar.recover_pose(E, pts1[mask], pts2[mask], K1, K2)
    else:
        R, t, _ = epipolar.recover_pose(E, pts1, pts2, K1, K2)
    return E, R, t, mask


def _reprojection_error(x_world: np.ndarray, x_img: np.ndarray, K: np.ndarray,
                        R: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Per-point L2 reprojection error (pixels); ``inf`` for points behind the camera (``z ≤ 0``)."""
    cam = x_world @ R.T + t  # (N, 3)
    z = cam[:, 2]
    proj = cam @ K.T
    with np.errstate(divide="ignore", invalid="ignore"):
        uv = proj[:, :2] / proj[:, 2:3]
    err = np.linalg.norm(uv - x_img, axis=1)
    return np.where(z > 1e-9, err, np.inf)


def ransac_pnp(points3d, points2d, K, *, seed: int = 0, threshold: float = 4.0,
               max_iters: int = 1000, confidence: float = 0.999):
    """Robustly resect the world-to-camera pose from contaminated 3D↔2D correspondences via MSAC.

    Minimal sample 6 → DLT-PnP (:func:`app.core.pnp.solve_pnp_dlt`), reprojection-error scoring, then a
    Levenberg-Marquardt refine (:func:`app.core.pnp.refine_pnp`) on the recovered inliers.

    Args:
        points3d: ``(N, 3)`` world landmarks.
        points2d: ``(N, 2)`` their pixel observations.
        K: ``(3, 3)`` shared intrinsics.
        seed: RNG seed (one ``Generator`` threaded through all sampling — D-10).
        threshold: reprojection inlier threshold in pixels.
        max_iters: fixed iteration budget.
        confidence: adaptive early-stop confidence.

    Returns:
        ``(R (3, 3), t (3,), inlier_mask (N,) bool)`` — pose refined on the recovered inlier set.

    Raises:
        ValueError: if fewer than 6 correspondences are given or no model could be fit.
    """
    x_world = np.asarray(points3d, dtype=np.float64)
    x_img = np.asarray(points2d, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    n = x_world.shape[0]
    rng = np.random.Generator(np.random.PCG64(seed))

    def fit(sample: np.ndarray) -> list:
        try:
            R, t = pnp.solve_pnp_dlt(x_world[sample], x_img[sample], K)
        except (ValueError, np.linalg.LinAlgError):
            return []
        return [(R, t)]

    def resid(model) -> np.ndarray:
        R, t = model
        return _reprojection_error(x_world, x_img, K, R, t)

    model, mask, _ = _msac(n, 6, fit, resid, rng, threshold, max_iters, confidence)
    if model is None:
        raise ValueError("RANSAC could not resect a pose (too few / degenerate points)")

    R, t = model
    if int(mask.sum()) >= 6:
        R, t = pnp.refine_pnp(R, t, x_world[mask], x_img[mask], K)
    return R, t, mask
