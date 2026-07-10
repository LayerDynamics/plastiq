"""Bundle-adjustment residuals, parameterization, and Jacobian sparsity (P4.1).

Bundle adjustment jointly refines camera poses, 3D points, and the shared camera intrinsics by
minimizing reprojection error. This module supplies the pieces the optimizer needs: an angle-axis
(Rodrigues) pose parameterization, a flat parameter-vector layout, the reprojection ``residuals``
(with the shared Brown-Conrady intrinsics), and the analytic ``jacobian_sparsity`` pattern that lets
``scipy.optimize.least_squares`` exploit the block structure (each observation touches only its own
camera, its own point, and the shared intrinsics). The ``trf`` optimization loop itself is P4.2,
appended to this module.

Parameter layout (a single flat float64 vector ``x``)::

    [ f, cx, cy, k1, k2, p1, p2 ]           # 7 shared intrinsics (single focal, fx = fy = f)
    [ rvec(3), tvec(3) ] × n_cams           # 6 per camera (world→camera, angle-axis + translation)
    [ X, Y, Z ] × n_pts                     # 3 per 3D point

Numerics (docs/adr/0013 D-9): pure float64 numpy/scipy on the CPU — the sparse solver tier,
deterministic, MLX-free. The Brown-Conrady forward model is reused from ``app.core.distortion`` (no
duplication). OpenCV/pycolmap are never imported here.

Attribution: the reprojection-BA formulation follows the standard scipy large-scale bundle-adjustment
cookbook (analytic ``jac_sparsity`` + robust loss) and Hartley & Zisserman §A6; the angle-axis maps
use ``scipy.spatial.transform.Rotation`` (Rodrigues).
"""

from __future__ import annotations

import numpy as np
import scipy.optimize
import scipy.sparse
from scipy.spatial.transform import Rotation

from app.core.distortion import distort_points

_N_INTRINSICS = 7
_N_CAM = 6

__all__ = [
    "rodrigues",
    "inverse_rodrigues",
    "pack",
    "unpack",
    "residuals",
    "jacobian_sparsity",
    "run_bundle_adjustment",
]


def rodrigues(rvec) -> np.ndarray:
    """Angle-axis vector → ``(3, 3)`` rotation matrix (Rodrigues)."""
    return Rotation.from_rotvec(np.asarray(rvec, dtype=np.float64)).as_matrix()


def inverse_rodrigues(R) -> np.ndarray:
    """``(3, 3)`` rotation matrix → its angle-axis vector."""
    return Rotation.from_matrix(np.asarray(R, dtype=np.float64)).as_rotvec()


def pack(intrinsics, cam_params, points) -> np.ndarray:
    """Flatten ``(intrinsics(7,), cam_params(n_cams, 6), points(n_pts, 3))`` → the parameter vector."""
    intr = np.asarray(intrinsics, dtype=np.float64).ravel()
    cams = np.asarray(cam_params, dtype=np.float64)
    pts = np.asarray(points, dtype=np.float64)
    if intr.size != _N_INTRINSICS:
        raise ValueError(f"intrinsics must have {_N_INTRINSICS} entries; got {intr.size}")
    if cams.ndim != 2 or cams.shape[1] != _N_CAM:
        raise ValueError(f"cam_params must be (n_cams, 6); got {cams.shape}")
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise ValueError(f"points must be (n_pts, 3); got {pts.shape}")
    return np.concatenate([intr, cams.ravel(), pts.ravel()])


def unpack(x, n_cams: int, n_pts: int):
    """Inverse of :func:`pack` → ``(intrinsics(7,), cam_params(n_cams, 6), points(n_pts, 3))``."""
    x = np.asarray(x, dtype=np.float64)
    expected = _N_INTRINSICS + _N_CAM * n_cams + 3 * n_pts
    if x.size != expected:
        raise ValueError(f"x has {x.size} entries; expected {expected} for {n_cams} cams, {n_pts} pts")
    intr = x[:_N_INTRINSICS]
    off = _N_INTRINSICS
    cams = x[off : off + _N_CAM * n_cams].reshape(n_cams, _N_CAM)
    off += _N_CAM * n_cams
    pts = x[off : off + 3 * n_pts].reshape(n_pts, 3)
    return intr, cams, pts


def _project(intr, cam_params_per_obs, points_per_obs) -> np.ndarray:
    """Project ``(K, 3)`` world points through their ``(K, 6)`` cameras with shared intrinsics ``intr``.

    Returns ``(K, 2)`` pixel coordinates (Brown-Conrady applied to the normalized coordinates)."""
    f, cx, cy = intr[0], intr[1], intr[2]
    dist = intr[3:7]
    rvecs = cam_params_per_obs[:, :3]
    tvecs = cam_params_per_obs[:, 3:]
    R = Rotation.from_rotvec(rvecs).as_matrix()  # (K, 3, 3)
    x_cam = np.einsum("kij,kj->ki", R, points_per_obs) + tvecs  # (K, 3)
    xn = x_cam[:, 0] / x_cam[:, 2]
    yn = x_cam[:, 1] / x_cam[:, 2]
    distorted = distort_points(np.stack([xn, yn], axis=1), dist)  # (K, 2)
    u = f * distorted[:, 0] + cx
    v = f * distorted[:, 1] + cy
    return np.stack([u, v], axis=1)


def residuals(x, observations, n_cams: int, n_pts: int) -> np.ndarray:
    """Reprojection residuals for every observation, stacked as ``(2 * K,)``.

    Args:
        x: the packed parameter vector.
        observations: ``(K, 4)`` rows ``(cam_idx, pt_idx, u, v)``.
        n_cams, n_pts: problem sizes (to unpack ``x``).

    Returns:
        ``(2 * K,)`` = ``[(u_proj - u), (v_proj - v)]`` per observation, interleaved row-major.
    """
    intr, cams, pts = unpack(x, n_cams, n_pts)
    obs = np.asarray(observations, dtype=np.float64)
    if obs.ndim != 2 or obs.shape[1] != 4:
        raise ValueError(f"observations must be (K, 4) [cam_idx, pt_idx, u, v]; got {obs.shape}")
    cam_idx = obs[:, 0].astype(np.intp)
    pt_idx = obs[:, 1].astype(np.intp)
    uv = obs[:, 2:4]
    proj = _project(intr, cams[cam_idx], pts[pt_idx])
    return (proj - uv).ravel()


def jacobian_sparsity(observations, n_cams: int, n_pts: int) -> scipy.sparse.lil_matrix:
    """Analytic nonzero pattern of the residual Jacobian (``2K × n_params``).

    Residual pair ``2i, 2i+1`` (observation ``i`` of camera ``c`` seeing point ``p``) depends only on:
    the 7 shared intrinsics, camera ``c``'s 6 parameters, and point ``p``'s 3 — 16 columns per row.
    Feeding this to ``scipy.optimize.least_squares(jac_sparsity=...)`` turns the dense Jacobian into a
    banded one, which is what makes BA tractable at scale (R-2).
    """
    obs = np.asarray(observations, dtype=np.float64)
    if obs.ndim != 2 or obs.shape[1] != 4:
        raise ValueError(f"observations must be (K, 4); got {obs.shape}")
    n_obs = obs.shape[0]
    n_params = _N_INTRINSICS + _N_CAM * n_cams + 3 * n_pts
    S = scipy.sparse.lil_matrix((2 * n_obs, n_params), dtype=np.int8)
    cam_base = _N_INTRINSICS
    pt_base = _N_INTRINSICS + _N_CAM * n_cams
    for i in range(n_obs):
        c = int(obs[i, 0])
        p = int(obs[i, 1])
        rows = [2 * i, 2 * i + 1]
        cols = list(range(_N_INTRINSICS))  # shared intrinsics
        cols += list(range(cam_base + _N_CAM * c, cam_base + _N_CAM * c + _N_CAM))  # this camera
        cols += list(range(pt_base + 3 * p, pt_base + 3 * p + 3))  # this point
        for r in rows:
            for col in cols:
                S[r, col] = 1
    return S


# --- P4.2: the trust-region-reflective optimization loop ---------------------------------------
#
# This is the standard scipy large-scale bundle-adjustment formulation (the "Large-scale bundle
# adjustment in scipy" cookbook): feed ``residuals`` and the analytic ``jacobian_sparsity`` to
# ``scipy.optimize.least_squares(method="trf")`` with a robust (Huber) loss and ``x_scale="jac"`` to
# balance the wildly different parameter scales (focal ~10²px, translations ~1, angle-axis ~10⁻¹,
# points ~1, distortion ~0). ``trf`` + a sparse ``jac_sparsity`` selects the ``lsmr`` trust-region
# subproblem solver, which is what keeps BA tractable as observations grow (R-2, SPEC-13 §5.3).
#
# Partial-freedom modes (SPEC-13 §5.4-3 — self-calibration schedule: intrinsics free only after 8
# registered views; local BA optimizes only the newest views) are implemented the clean way: build a
# boolean free-mask over the flat parameter vector, optimize only the reduced free sub-vector, and
# scatter the result back onto a copy of ``x0`` — so every *held* parameter is byte-for-byte
# unchanged in the output (no bounds/penalty tricks, no gauge drift on frozen cameras).


def _free_mask(n_cams: int, n_pts: int, fix_intrinsics: bool, free_cams) -> np.ndarray:
    """Boolean mask (length ``n_params``) of the parameters BA is allowed to move.

    Points are always free (correct local-BA semantics: newly triangulated structure moves with the
    newest views). ``fix_intrinsics`` freezes the 7 shared intrinsics; ``free_cams`` (an iterable of
    camera indices) freezes every camera *not* listed — the others, and all points, stay free.
    """
    n_params = _N_INTRINSICS + _N_CAM * n_cams + 3 * n_pts
    mask = np.ones(n_params, dtype=bool)
    if fix_intrinsics:
        mask[:_N_INTRINSICS] = False
    if free_cams is not None:
        free_set = {int(c) for c in free_cams}
        for c in range(n_cams):
            if c not in free_set:
                base = _N_INTRINSICS + _N_CAM * c
                mask[base : base + _N_CAM] = False
    return mask


def run_bundle_adjustment(
    x0,
    observations,
    n_cams: int,
    n_pts: int,
    *,
    fix_intrinsics: bool = False,
    free_cams=None,
    max_iter: int = 100,
    loss: str = "huber",
    f_scale: float = 1.0,
    ftol: float = 1e-6,
    xtol: float = 1e-6,
    gtol: float = 1e-6,
):
    """Refine ``x0`` by sparse Levenberg-Marquardt-style trust-region reflective bundle adjustment.

    Wraps ``scipy.optimize.least_squares(residuals, …, method="trf", loss=loss, f_scale=f_scale,
    jac_sparsity=jacobian_sparsity(…))``. Deterministic (``trf`` and finite-difference Jacobians are
    RNG-free): identical inputs → bit-identical outputs.

    Args:
        x0: the packed parameter vector to refine (see module docstring for the layout).
        observations: ``(K, 4)`` rows ``(cam_idx, pt_idx, u, v)``.
        n_cams, n_pts: problem sizes (to unpack ``x0``).
        fix_intrinsics: hold the 7 shared intrinsics fixed (optimize cameras + points only).
        free_cams: iterable of camera indices allowed to move (local BA); every other camera is held.
            ``None`` (default) frees all cameras.
        max_iter: iteration cap → ``max_nfev = max_iter * (n_free + 1)`` (a documented upper bound on
            work; the tolerances stop the solver far earlier on these problems).
        loss: ``least_squares`` loss ("huber" for outlier robustness, "linear" for plain least squares).
        f_scale: soft threshold (in pixels) separating inliers from outliers for the robust loss.

    Returns:
        ``(x_opt, info)`` — ``x_opt`` is a copy of ``x0`` with the free parameters replaced by the
        solution (held parameters byte-for-byte identical), and ``info`` is a dict with keys
        ``success`` (bool), ``cost`` (final robust cost), ``mean_reprojection_error`` (mean per-obs
        Euclidean pixel error at ``x_opt``), ``n_iterations`` (``njev`` — trust-region iterations),
        ``n_free_params`` (int), and ``status`` (scipy termination code).
    """
    x0 = np.asarray(x0, dtype=np.float64)
    obs = np.asarray(observations, dtype=np.float64)

    mask = _free_mask(n_cams, n_pts, fix_intrinsics, free_cams)
    free_idx = np.flatnonzero(mask)
    x_free0 = x0[free_idx]

    def _residuals_free(x_free: np.ndarray) -> np.ndarray:
        x_full = x0.copy()
        x_full[free_idx] = x_free
        return residuals(x_full, obs, n_cams, n_pts)

    spar_full = jacobian_sparsity(obs, n_cams, n_pts).tocsc()
    spar_free = spar_full[:, free_idx]

    result = scipy.optimize.least_squares(
        _residuals_free,
        x_free0,
        jac_sparsity=spar_free,
        method="trf",
        loss=loss,
        f_scale=f_scale,
        x_scale="jac",
        ftol=ftol,
        xtol=xtol,
        gtol=gtol,
        max_nfev=max_iter * (free_idx.size + 1),
    )

    x_opt = x0.copy()
    x_opt[free_idx] = result.x

    mean_reproj = _mean_reprojection_error(x_opt, obs, n_cams, n_pts)
    info = {
        "success": bool(result.success),
        "cost": float(result.cost),
        "mean_reprojection_error": mean_reproj,
        "n_iterations": int(result.njev if result.njev is not None else result.nfev),
        "n_free_params": int(free_idx.size),
        "status": int(result.status),
    }
    return x_opt, info


def _mean_reprojection_error(x, observations, n_cams: int, n_pts: int) -> float:
    """Mean per-observation Euclidean reprojection error (pixels) for the packed vector ``x``."""
    r = residuals(x, observations, n_cams, n_pts)
    du = r[0::2]
    dv = r[1::2]
    return float(np.mean(np.sqrt(du * du + dv * dv)))
