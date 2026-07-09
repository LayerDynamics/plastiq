"""Umeyama (1991) similarity alignment — a TEST-ONLY metric utility (not shipped in app/).

Structure-from-Motion recovers geometry only up to a global similarity (rotation, translation,
uniform scale), so a reconstructed camera set can only be compared to ground truth *after* aligning
the two by the best similarity. This is the closed-form least-squares solution of Umeyama, S.,
"Least-squares estimation of transformation parameters between two point patterns", PAMI 1991 — kornia
ships no such routine (confirmed), so it is written fresh here for the P5 mapper's accuracy tests.
"""

from __future__ import annotations

import numpy as np


def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Best similarity ``(s, R, t)`` mapping ``src`` onto ``dst``: minimises ``Σ‖dst − (s R src + t)‖²``.

    Args:
        src, dst: ``(N, 3)`` corresponding point sets (e.g. reconstructed vs ground-truth camera
            centres), in the same order.

    Returns:
        ``(s, R, t)`` — scale ``s`` (float), rotation ``R`` (3×3, proper), translation ``t`` (3,) — so
        ``dst ≈ s R srcᵀ + t``.
    """
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    n = src.shape[0]
    mu_src = src.mean(axis=0)
    mu_dst = dst.mean(axis=0)
    src_c = src - mu_src
    dst_c = dst - mu_dst
    var_src = float(np.sum(src_c ** 2) / n)
    cov = (dst_c.T @ src_c) / n  # (3, 3) cross-covariance
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:  # ensure a proper rotation (no reflection)
        S[2, 2] = -1.0
    R = U @ S @ Vt
    s = float(np.trace(np.diag(D) @ S) / var_src) if var_src > 1e-18 else 1.0
    t = mu_dst - s * R @ mu_src
    return s, R, t


def aligned_rmse(src: np.ndarray, dst: np.ndarray) -> float:
    """RMSE of ``src`` aligned onto ``dst`` by the best similarity (Umeyama)."""
    s, R, t = umeyama(src, dst)
    mapped = (s * (R @ np.asarray(src, dtype=np.float64).T).T) + t
    return float(np.sqrt(np.mean(np.sum((mapped - np.asarray(dst, dtype=np.float64)) ** 2, axis=1))))
