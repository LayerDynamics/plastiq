"""Perspective-n-Point camera resection: DLT initial pose + Levenberg-Marquardt refinement.

Given ``N ≥ 6`` 3D↔2D correspondences (world landmarks ``points3d`` (N,3) and their pixel
observations ``points2d`` (N,2)) and the shared pinhole intrinsics ``K`` (3,3), this estimates the
world-to-camera pose ``(R (3,3), t (3,))`` in the OpenCV / +z-forward solver frame SPEC-13 uses
(a world point ``X`` maps to camera space by ``X_c = R X + t``).

``solve_pnp_dlt`` — the Direct Linear Transform resection:

1. Hartley-normalize the world points (mean-isotropic similarity ``T3``, 4×4) and the image points
   (``T2``, 3×3) so the 2N×12 design matrix is well-conditioned — without this the noise-free bar
   (< 1e-6°) is not reliably reachable because metres and pixels differ by orders of magnitude.
2. Build the 2N×12 homogeneous system ``A p = 0`` for the projection ``P = K[R|t]`` (in normalized
   coordinates), two rows per correspondence, and take its right null vector (last right singular
   vector of ``A``) as ``P_norm`` (3×4).
3. De-normalize: ``P = T2⁻¹ P_norm T3``. Then ``M = K⁻¹ P ≈ c [R|t]`` for an unknown scalar ``c``.
4. Recover a proper pose from ``M``: fix the global sign so ``det(M[:, :3]) > 0`` (this forces
   ``c > 0``, hence points in front of the camera — no separate cheirality flip needed), project
   ``M[:, :3]`` onto the rotation group by SVD (``R = U diag(1,1,det(UVᵀ)) Vᵀ``, det +1), and take
   the scale from the singular values so ``t = M[:, 3] / mean(σ)``.

Degeneracy: if all world points are collinear or coplanar the resection is not uniquely solvable;
the smallest singular value of the mean-normalized world points falls below ``svd_eps`` and a clear
``ValueError`` is raised (never a wrong pose). ``N < 6`` also raises.

``refine_pnp`` — Levenberg-Marquardt minimization of the geometric reprojection error over an
angle-axis (rotation vector) + translation parameterization (6 params) via
``scipy.optimize.least_squares(method="lm")``, started from the DLT estimate.

Numerics (docs/adr/0013 D-9): pure float64 numpy/scipy on the CPU — the sparse/combinatorial solver
tier, deterministic (fixed-size SVD / bounded LM carry no RNG) and MLX-free. OpenCV is a *test-only*
oracle (D-1) and is never imported here.

Algorithm reimplemented (no code copied) with attribution from kornia (Apache-2.0):
``kornia/geometry/calibration/pnp.py::solve_pnp_dlt`` (the mean-isotropic normalization + DLT
nullspace formulation) — which follows Hartley & Zisserman, *Multiple View Geometry*, 2nd ed. §7
(camera resection / the DLT). The rotation-group SVD projection follows H&Z §A4.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

__all__ = ["solve_pnp_dlt", "refine_pnp"]


def _as_points3d(points) -> np.ndarray:
    p = np.asarray(points, dtype=np.float64)
    if p.ndim != 2 or p.shape[-1] != 3:
        raise ValueError(f"points3d must have shape (N, 3); got {p.shape}")
    return p


def _as_points2d(points) -> np.ndarray:
    p = np.asarray(points, dtype=np.float64)
    if p.ndim != 2 or p.shape[-1] != 2:
        raise ValueError(f"points2d must have shape (N, 2); got {p.shape}")
    return p


def _as_intrinsics(k) -> np.ndarray:
    m = np.asarray(k, dtype=np.float64)
    if m.shape != (3, 3):
        raise ValueError(f"K must have shape (3, 3); got {m.shape}")
    return m


def _mean_isotropic_transform(points: np.ndarray, eps: float = 1e-12) -> np.ndarray:
    """Similarity transform (D+1)×(D+1) normalizing ``points`` (N, D) to zero mean and mean radius
    ``sqrt(D)`` — Hartley's isotropic scaling (H&Z §4.4.4). Applied in homogeneous coordinates."""
    d = points.shape[1]
    mean = points.mean(axis=0)
    dist = np.linalg.norm(points - mean, axis=1).mean()
    scale = np.sqrt(d) / (dist + eps)
    t = np.eye(d + 1, dtype=np.float64)
    t[:d, :d] *= scale
    t[:d, d] = -scale * mean
    return t


def _apply_transform(t: np.ndarray, points: np.ndarray) -> np.ndarray:
    """Apply a (D+1)×(D+1) homogeneous similarity to ``points`` (N, D) → (N, D)."""
    hom = np.concatenate([points, np.ones((points.shape[0], 1))], axis=1)
    out = hom @ t.T
    return out[:, :-1] / out[:, -1:]


def solve_pnp_dlt(points3d, points2d, k, svd_eps: float = 1e-4):
    """Resect the world-to-camera pose ``(R (3,3), t (3,))`` from ``N ≥ 6`` 3D↔2D correspondences.

    See the module docstring for the algorithm. Raises ``ValueError`` for ``N < 6`` or for a
    collinear/coplanar (rank-deficient) world-point configuration.
    """
    x_world = _as_points3d(points3d)
    x_img = _as_points2d(points2d)
    k_mat = _as_intrinsics(k)
    n = x_world.shape[0]
    if n != x_img.shape[0]:
        raise ValueError(f"points3d and points2d must have equal length; got {n} vs {x_img.shape[0]}")
    if n < 6:
        raise ValueError(f"DLT-PnP needs at least 6 correspondences; got {n}")

    # Degeneracy: mean-normalized world points must have rank 3 (not on a line or plane).
    centered = x_world - x_world.mean(axis=0)
    scale = np.sqrt(3.0) / (np.linalg.norm(centered, axis=1).mean() + 1e-12)
    world_norm_check = centered * scale
    if np.linalg.svd(world_norm_check, compute_uv=False)[-1] < svd_eps:
        raise ValueError(
            "world points are collinear or coplanar (rank-deficient); DLT-PnP has no unique "
            f"solution (smallest normalized singular value < {svd_eps})."
        )

    # Hartley normalization of both point sets.
    t3 = _mean_isotropic_transform(x_world)
    t2 = _mean_isotropic_transform(x_img)
    world_n = _apply_transform(t3, x_world)
    img_n = _apply_transform(t2, x_img)
    world_h = np.concatenate([world_n, np.ones((n, 1))], axis=1)  # (N, 4)

    # Build the 2N×12 DLT design for P (row-major reshape to (3, 4)):
    #   row(u): X·p1 - u (X·p3) = 0 ;  row(v): X·p2 - v (X·p3) = 0.
    system = np.zeros((2 * n, 12), dtype=np.float64)
    system[0::2, 0:4] = world_h
    system[1::2, 4:8] = world_h
    system[0::2, 8:12] = -img_n[:, 0:1] * world_h
    system[1::2, 8:12] = -img_n[:, 1:2] * world_h

    _, _, vt = np.linalg.svd(system)
    p_norm = vt[-1].reshape(3, 4)

    # De-normalize: u = T2⁻¹ P_norm T3 X_h  ⇒  P = T2⁻¹ P_norm T3.
    p = np.linalg.inv(t2) @ p_norm @ t3
    m = np.linalg.inv(k_mat) @ p  # ≈ c [R | t]

    # Fix the global sign so det(M[:, :3]) > 0 ⇒ c > 0 ⇒ points in front of the camera.
    if np.linalg.det(m[:, :3]) < 0:
        m = -m

    # Project M[:, :3] onto SO(3); the scale comes from the singular values (t = translation / scale).
    u, sigma, vh = np.linalg.svd(m[:, :3])
    r = u @ np.diag([1.0, 1.0, np.linalg.det(u @ vh)]) @ vh
    t_vec = m[:, 3] / sigma.mean()
    return r, t_vec


def _reprojection_residuals(params: np.ndarray, x_world: np.ndarray, x_img: np.ndarray,
                            k_mat: np.ndarray) -> np.ndarray:
    """Flattened per-coordinate reprojection residuals (length 2N) for LM.

    ``params`` = [rotvec(3), t(3)]. Projects ``x_world`` with the pinhole ``K[R|t]`` and returns
    ``(u_proj - u_obs, v_proj - v_obs)`` stacked."""
    r = Rotation.from_rotvec(params[:3]).as_matrix()
    t = params[3:6]
    cam = x_world @ r.T + t  # (N, 3)
    proj = cam @ k_mat.T
    uv = proj[:, :2] / proj[:, 2:3]
    return (uv - x_img).ravel()


def refine_pnp(r, t, points3d, points2d, k):
    """Levenberg-Marquardt reprojection refinement of a pose ``(R, t)`` over angle-axis+translation.

    Returns the refined ``(R (3,3), t (3,))``; minimizes the geometric reprojection error the DLT
    only approximates algebraically, so on noisy data it strictly improves on the DLT estimate.
    """
    x_world = _as_points3d(points3d)
    x_img = _as_points2d(points2d)
    k_mat = _as_intrinsics(k)
    r0 = np.asarray(r, dtype=np.float64)
    t0 = np.asarray(t, dtype=np.float64)
    params0 = np.concatenate([Rotation.from_matrix(r0).as_rotvec(), t0])

    result = least_squares(
        _reprojection_residuals,
        params0,
        method="lm",
        args=(x_world, x_img, k_mat),
        max_nfev=200,
    )
    r_ref = Rotation.from_rotvec(result.x[:3]).as_matrix()
    t_ref = result.x[3:6]
    return r_ref, t_ref
