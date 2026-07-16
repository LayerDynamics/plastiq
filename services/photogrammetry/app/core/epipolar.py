"""Two-view epipolar geometry: 8-point fundamental (+ Sampson) and the Nistér 5-point essential.

The fundamental matrix ``F`` relates a correspondence ``(x1, x2)`` (pixels in views 1 and 2) by the
epipolar constraint ``x2ᵀ F x1 = 0`` with homogeneous ``x = [u, v, 1]`` — the same "points2 on the
left" convention OpenCV's ``findFundamentalMat`` uses, so oracle parity is direct. ``find_fundamental``
is the normalized 8-point DLT (Hartley/Zisserman §11.2): isotropic normalization → the 9-column design
matrix → SVD nullspace → rank-2 enforcement → denormalization → unit-Frobenius scaling.
``sampson_distance`` is the first-order geometric epipolar error (Hartley/Zisserman §11.4.3).

``find_essential`` is the Nistér five-point solver (see the P2.3 block at the bottom of this file):
from ``N ≥ 5`` correspondences and the intrinsics it returns up to ten candidate essential matrices
``E`` (same ``x2ᵀ E x1 = 0`` convention, on K-calibrated coordinates). ``decompose_essential`` and
``recover_pose`` turn a candidate into the relative rotation/translation, choosing the cheirality-valid
configuration. These parallel OpenCV's ``findEssentialMat`` / ``recoverPose`` (test-only oracles).

**Units:** ``sampson_distance`` returns the *non-squared* Sampson distance (√ of the ratio), i.e. an
approximate geometric distance in **pixels** — thresholdable directly. Downstream MSAC (P3.1) that
wants the squared error should square this. A small ``eps`` guards the denominator against points near
an epipole (which would otherwise divide by ~0).

``normalize_points_2d`` is public because the later Nistér 5-point essential-matrix solver (P2.3, same
module) reuses it.

Numerics (docs/adr/0013 D-9): pure float64 numpy on the CPU — the sparse/combinatorial solver tier,
deterministic and MLX-free. OpenCV is a *test-only* oracle (D-1) and is never imported here.

Algorithm reimplemented (no code copied) with attribution from kornia (Apache-2.0):
``kornia/geometry/epipolar/fundamental.py::{normalize_points, run_8point}`` and
``kornia/geometry/epipolar/_metrics.py::sampson_epipolar_distance`` — which in turn follow
Hartley & Zisserman, *Multiple View Geometry*, 2nd ed. (§4.4.4, §11.2, §11.4.3).
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "normalize_points_2d",
    "find_fundamental",
    "sampson_distance",
    "find_essential",
    "decompose_essential",
    "recover_pose",
]


def _as_points(points):
    """Validate/copy an ``(N, 2)`` float64 array of image points."""
    p = np.asarray(points, dtype=np.float64)
    if p.ndim != 2 or p.shape[-1] != 2:
        raise ValueError(f"points must have shape (N, 2); got {p.shape}")
    return p


def normalize_points_2d(points, eps: float = 1e-12):
    """Hartley isotropic normalization (Hartley/Zisserman §4.4.4).

    Translates the centroid to the origin and scales so the mean distance to the origin is ``√2``,
    conditioning the DLT design matrix. The returned similarity ``T`` (3×3) satisfies
    ``[x_norm, 1]ᵀ = T [x, 1]ᵀ``.

    Args:
        points: ``(N, 2)`` image points.
        eps: guards against a degenerate (all-coincident) point set.

    Returns:
        ``(points_norm (N, 2), T (3, 3))``.
    """
    pts = _as_points(points)
    centroid = pts.mean(axis=0)
    centered = pts - centroid
    mean_dist = np.linalg.norm(centered, axis=1).mean()
    scale = np.sqrt(2.0) / (mean_dist + eps)
    points_norm = centered * scale
    T = np.array(
        [
            [scale, 0.0, -scale * centroid[0]],
            [0.0, scale, -scale * centroid[1]],
            [0.0, 0.0, 1.0],
        ]
    )
    return points_norm, T


def find_fundamental(points1, points2):
    """Estimate the fundamental matrix by the normalized 8-point algorithm.

    Solves ``x2ᵀ F x1 = 0`` over ``N ≥ 8`` correspondences: Hartley-normalize each view, build the
    9-column DLT design matrix, take the right nullspace via SVD, enforce ``rank(F) = 2`` by zeroing
    the smallest singular value, denormalize (``F = T2ᵀ F̃ T1``), and scale to unit Frobenius norm.

    Args:
        points1: ``(N, 2)`` points in image 1.
        points2: ``(N, 2)`` corresponding points in image 2 (same order).

    Returns:
        ``F`` ``(3, 3)``, ``‖F‖_F = 1``.

    Raises:
        ValueError: if fewer than 8 correspondences are given or the shapes disagree.
    """
    pts1 = _as_points(points1)
    pts2 = _as_points(points2)
    if pts1.shape != pts2.shape:
        raise ValueError(f"points1 and points2 must have the same shape; got {pts1.shape} vs {pts2.shape}")
    if pts1.shape[0] < 8:
        raise ValueError(f"the 8-point algorithm needs >= 8 correspondences; got {pts1.shape[0]}")

    p1n, T1 = normalize_points_2d(pts1)
    p2n, T2 = normalize_points_2d(pts2)
    x1, y1 = p1n[:, 0], p1n[:, 1]
    x2, y2 = p2n[:, 0], p2n[:, 1]
    ones = np.ones_like(x1)

    # Row A_i = [x2·x1, x2·y1, x2, y2·x1, y2·y1, y2, x1, y1, 1] so that A f = 0 encodes x2ᵀ F x1 = 0.
    A = np.stack([x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, ones], axis=1)

    _, _, Vt = np.linalg.svd(A)
    F_hat = Vt[-1].reshape(3, 3)  # right singular vector of the smallest singular value

    # Enforce rank 2: zero the smallest singular value.
    U, S, Vt2 = np.linalg.svd(F_hat)
    S[-1] = 0.0
    F_rank2 = (U * S) @ Vt2

    # Denormalize to the original pixel frame.
    F = T2.T @ F_rank2 @ T1

    norm = np.linalg.norm(F)
    if norm > 0.0:
        F = F / norm
    return F


def sampson_distance(F, points1, points2, eps: float = 1e-8):
    """First-order (Sampson) geometric epipolar error per correspondence.

    Approximates the geometric distance (in pixels) between each correspondence and the nearest pair
    exactly satisfying ``x2ᵀ F x1 = 0`` (Hartley/Zisserman §11.4.3). Scale-invariant in ``F``.

    Args:
        F: ``(3, 3)`` fundamental matrix.
        points1: ``(N, 2)`` points in image 1.
        points2: ``(N, 2)`` corresponding points in image 2.
        eps: denominator guard for points near an epipole.

    Returns:
        ``(N,)`` non-squared Sampson distances.
    """
    F = np.asarray(F, dtype=np.float64)
    if F.shape != (3, 3):
        raise ValueError(f"F must have shape (3, 3); got {F.shape}")
    pts1 = _as_points(points1)
    pts2 = _as_points(points2)
    if pts1.shape != pts2.shape:
        raise ValueError(f"points1 and points2 must have the same shape; got {pts1.shape} vs {pts2.shape}")

    x1 = np.hstack([pts1, np.ones((pts1.shape[0], 1))])  # (N, 3)
    x2 = np.hstack([pts2, np.ones((pts2.shape[0], 1))])  # (N, 3)

    Fx1 = x1 @ F.T  # (N, 3) epipolar line in image 2
    Ftx2 = x2 @ F  # (N, 3) epipolar line in image 1
    residual = np.einsum("ni,ni->n", x2, Fx1)  # x2ᵀ F x1

    numerator = residual ** 2
    denominator = Fx1[:, 0] ** 2 + Fx1[:, 1] ** 2 + Ftx2[:, 0] ** 2 + Ftx2[:, 1] ** 2
    return np.sqrt(numerator / (denominator + eps))


# ============================================================================================
# Nistér five-point relative-pose solver (P2.3)
# ============================================================================================
#
# The minimal solver for the calibrated essential matrix from 5 point correspondences (Nistér,
# "An Efficient Solution to the Five-Point Relative Pose Problem", PAMI 2004). Algorithm
# reimplemented (no code copied) with attribution from kornia (Apache-2.0),
# ``kornia/geometry/epipolar/essential.py::{run_5point, null_to_Nister_solution,
# decompose_essential_matrix, motion_from_essential_choose_solution}``, which follow Nistér 2004.
#
# The degree-10 elimination is done here by the standard **action-matrix (Gröbner) method** rather
# than kornia's precomputed coefficient tables: the essential matrix lives in the 4-D null space of
# the epipolar system, ``E = x·E0 + y·E1 + z·E2 + E3``; the determinant (``det E = 0``) and trace
# (``2 E Eᵀ E − tr(E Eᵀ) E = 0``) constraints give 10 cubic equations in ``(x, y, z)``; the quotient
# ring has dimension 10 with monomial basis ``{x², xy, xz, y², yz, z², x, y, z, 1}``, and the
# eigenvalues/eigenvectors of the multiplication-by-``z`` action matrix give the (up to 10) real
# solutions. Numerics: float64 numpy (D-9). No ``cv2``/``pycolmap`` import (D-1).

from app.core.triangulate import triangulate as _triangulate  # noqa: E402  (kept near its use)

# Monomials of total degree ≤ 3 in (x, y, z), split into the 10 degree-3 leading monomials and the
# 10 degree-≤2 quotient-basis monomials. Column order of the 10×20 constraint matrix.
_DEG3 = [(3, 0, 0), (2, 1, 0), (2, 0, 1), (1, 2, 0), (1, 1, 1), (1, 0, 2),
         (0, 3, 0), (0, 2, 1), (0, 1, 2), (0, 0, 3)]
_BASIS = [(2, 0, 0), (1, 1, 0), (1, 0, 1), (0, 2, 0), (0, 1, 1), (0, 0, 2),
          (1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, 0)]  # x² xy xz y² yz z² x y z 1
_MONOMIALS = _DEG3 + _BASIS
_MONO_INDEX = {m: i for i, m in enumerate(_MONOMIALS)}
_BASIS_INDEX = {m: i for i, m in enumerate(_BASIS)}
_DEG3_INDEX = {m: i for i, m in enumerate(_DEG3)}


def _poly_mul(a: dict, b: dict) -> dict:
    """Multiply two polynomials in (x, y, z) represented as ``{(i, j, k): coeff}`` dicts."""
    out: dict = {}
    for (ea, ca) in a.items():
        for (eb, cb) in b.items():
            key = (ea[0] + eb[0], ea[1] + eb[1], ea[2] + eb[2])
            out[key] = out.get(key, 0.0) + ca * cb
    return out


def _poly_add(a: dict, b: dict, scale: float = 1.0) -> dict:
    out = dict(a)
    for (e, c) in b.items():
        out[e] = out.get(e, 0.0) + scale * c
    return out


def _matmul_poly(A: list, B: list) -> list:
    """3×3 matrix product where entries are polynomial dicts."""
    out = [[{} for _ in range(3)] for _ in range(3)]
    for i in range(3):
        for j in range(3):
            acc: dict = {}
            for k in range(3):
                acc = _poly_add(acc, _poly_mul(A[i][k], B[k][j]))
            out[i][j] = acc
    return out


def _essential_constraints(basis_mats: np.ndarray) -> np.ndarray:
    """Build the 10×20 constraint matrix from the four null-space basis matrices ``(4, 3, 3)``.

    ``E(x, y, z) = x·E0 + y·E1 + z·E2 + E3`` with each entry a linear polynomial; returns the
    coefficients of the 10 cubic constraints (1 determinant + 9 trace) over ``_MONOMIALS``.
    """
    # E[i][j] as a linear polynomial dict over the monomials x=(1,0,0), y=(0,1,0), z=(0,0,1), 1=(0,0,0)
    lin_keys = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, 0)]
    E = [[None, None, None] for _ in range(3)]
    for i in range(3):
        for j in range(3):
            E[i][j] = {
                lin_keys[b]: float(basis_mats[b, i, j])
                for b in range(4)
                if basis_mats[b, i, j] != 0.0
            } or {(0, 0, 0): 0.0}

    def cof(a, b, c, d):  # a*d - b*c for four polynomial entries
        return _poly_add(_poly_mul(a, d), _poly_mul(b, c), scale=-1.0)

    det = _poly_add(
        _poly_add(
            _poly_mul(E[0][0], cof(E[1][1], E[1][2], E[2][1], E[2][2])),
            _poly_mul(E[0][1], cof(E[1][0], E[1][2], E[2][0], E[2][2])),
            scale=-1.0,
        ),
        _poly_mul(E[0][2], cof(E[1][0], E[1][1], E[2][0], E[2][1])),
    )

    Et = [[E[j][i] for j in range(3)] for i in range(3)]
    EEt = _matmul_poly(E, Et)
    trace = _poly_add(_poly_add(EEt[0][0], EEt[1][1]), EEt[2][2])
    two_EEt_E = _matmul_poly(EEt, E)

    constraints = [det]
    for i in range(3):
        for j in range(3):
            term = _poly_add(two_EEt_E[i][j], two_EEt_E[i][j])  # 2·(EEᵀE)
            term = _poly_add(term, _poly_mul(trace, E[i][j]), scale=-1.0)  # − tr(EEᵀ)·E
            constraints.append(term)

    M = np.zeros((10, 20), dtype=np.float64)
    for r, poly in enumerate(constraints):
        for (e, c) in poly.items():
            idx = _MONO_INDEX.get(e)
            if idx is None:
                raise ValueError(f"constraint {r} produced monomial {e} of degree > 3")
            M[r, idx] += c
    return M


def _action_matrix(M: np.ndarray) -> np.ndarray:
    """Multiplication-by-z action matrix (10×10) on the quotient basis from the 10×20 constraints.

    Gauss-Jordan eliminates the 10 degree-3 leading monomials (``M[:, :10]``): each is expressed in
    the basis as ``deg3 = Bmat · basis`` with ``Bmat = −M[:, :10]⁻¹ M[:, 10:]``. Then ``z·basis_j`` is
    either another basis monomial (direct) or a degree-3 monomial (substituted via ``Bmat``).
    """
    Bmat = -np.linalg.solve(M[:, :10], M[:, 10:])  # (10, 10): deg3 monomial → basis coords
    Az = np.zeros((10, 10), dtype=np.float64)
    for j, mono in enumerate(_BASIS):
        target = (mono[0], mono[1], mono[2] + 1)  # z · basis_j
        if target in _BASIS_INDEX:
            Az[_BASIS_INDEX[target], j] = 1.0
        else:
            Az[:, j] = Bmat[_DEG3_INDEX[target], :]
    return Az


def find_essential(points1, points2, K1, K2) -> np.ndarray:
    """Nistér five-point essential-matrix solver → up to 10 candidate matrices ``(n, 3, 3)``.

    Args:
        points1: ``(N, 2)`` pixel points in image 1 (``N ≥ 5``).
        points2: ``(N, 2)`` corresponding pixel points in image 2.
        K1, K2: ``(3, 3)`` intrinsics of camera 1 and camera 2.

    Returns:
        ``(n, 3, 3)`` real candidate essential matrices (``1 ≤ n ≤ 10``), each unit-Frobenius. The
        physically correct one is selected by :func:`recover_pose` via cheirality.

    Raises:
        ValueError: if fewer than 5 correspondences are given.
    """
    pts1 = _as_points(points1)
    pts2 = _as_points(points2)
    if pts1.shape != pts2.shape:
        raise ValueError(f"points1 and points2 must have the same shape; got {pts1.shape} vs {pts2.shape}")
    if pts1.shape[0] < 5:
        raise ValueError(f"the five-point algorithm needs >= 5 correspondences; got {pts1.shape[0]}")

    K1 = np.asarray(K1, dtype=np.float64)
    K2 = np.asarray(K2, dtype=np.float64)
    # Calibrated (normalized) coordinates: q = K⁻¹ [u, v, 1].
    q1 = np.linalg.solve(K1, np.hstack([pts1, np.ones((pts1.shape[0], 1))]).T).T
    q2 = np.linalg.solve(K2, np.hstack([pts2, np.ones((pts2.shape[0], 1))]).T).T
    x1, y1 = q1[:, 0], q1[:, 1]
    x2, y2 = q2[:, 0], q2[:, 1]
    ones = np.ones_like(x1)
    # Epipolar rows for q2ᵀ E q1 = 0, vec(E) row-major [E00..E22].
    A = np.stack([x2 * x1, x2 * y1, x2, y2 * x1, y2 * y1, y2, x1, y1, ones], axis=1)

    _, _, Vt = np.linalg.svd(A)
    basis_mats = np.stack([Vt[-4 + b].reshape(3, 3) for b in range(4)], axis=0)  # (4, 3, 3)

    M = _essential_constraints(basis_mats)
    try:
        Az = _action_matrix(M)
    except np.linalg.LinAlgError:
        # Degenerate leading block — fall back to the SVD nullspace's first basis (rare).
        E = basis_mats[3] / (np.linalg.norm(basis_mats[3]) + 1e-15)
        return E[None]

    # The monomial-evaluation vectors (b_k evaluated at each solution) are the eigenvectors of Azᵀ
    # (left eigenvectors of the multiplication-by-z action matrix), with eigenvalue z at that solution.
    evals, evecs = np.linalg.eig(Az.T)
    candidates = []
    for k in range(evals.shape[0]):
        if abs(evals[k].imag) > 1e-9:
            continue
        v = evecs[:, k].real
        if abs(v[_BASIS_INDEX[(0, 0, 0)]]) < 1e-12:  # the "1" component ≈ 0 → unusable
            continue
        v = v / v[_BASIS_INDEX[(0, 0, 0)]]
        x = v[_BASIS_INDEX[(1, 0, 0)]]
        y = v[_BASIS_INDEX[(0, 1, 0)]]
        z = evals[k].real
        E = x * basis_mats[0] + y * basis_mats[1] + z * basis_mats[2] + basis_mats[3]
        norm = np.linalg.norm(E)
        if norm < 1e-12:
            continue
        candidates.append(E / norm)
    if not candidates:
        E = basis_mats[3] / (np.linalg.norm(basis_mats[3]) + 1e-15)
        candidates.append(E)
    return np.stack(candidates, axis=0)


def decompose_essential(E) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Decompose an essential matrix into the two rotations and the translation direction.

    Returns ``(R1, R2, t)``; the four physical camera motions are ``(R1, ±t)`` and ``(R2, ±t)``
    (Hartley/Zisserman §9.6.2). ``E`` is projected onto the essential manifold (singular values
    ``(1, 1, 0)``) first for robustness.
    """
    E = np.asarray(E, dtype=np.float64)
    U, _, Vt = np.linalg.svd(E)
    if np.linalg.det(U) < 0:
        U[:, -1] *= -1.0
    if np.linalg.det(Vt) < 0:
        Vt[-1, :] *= -1.0
    W = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    R1 = U @ W @ Vt
    R2 = U @ W.T @ Vt
    t = U[:, 2]
    return R1, R2, t


def recover_pose(candidates, points1, points2, K1, K2):
    """Select the physically correct ``(R, t)`` from essential-matrix candidate(s) via cheirality.

    Accepts a single ``(3, 3)`` matrix or a stack ``(n, 3, 3)`` (e.g. from :func:`find_essential`).
    Triangulates the correspondences for every candidate × the four motion configs in normalized
    coordinates (camera 1 at the origin) and returns the ``(R, t, inlier_mask)`` with the most points
    in front of both cameras. ``t`` is a unit translation direction (scale is unobservable).
    """
    cand = np.asarray(candidates, dtype=np.float64)
    if cand.ndim == 2:
        cand = cand[None]
    pts1 = _as_points(points1)
    pts2 = _as_points(points2)
    K1 = np.asarray(K1, dtype=np.float64)
    K2 = np.asarray(K2, dtype=np.float64)
    q1 = np.linalg.solve(K1, np.hstack([pts1, np.ones((pts1.shape[0], 1))]).T).T[:, :2]
    q2 = np.linalg.solve(K2, np.hstack([pts2, np.ones((pts2.shape[0], 1))]).T).T[:, :2]
    P1 = np.hstack([np.eye(3), np.zeros((3, 1))])  # camera 1 at the origin (normalized coords)

    best = (-1, np.eye(3), np.array([0.0, 0.0, 1.0]), np.zeros(pts1.shape[0], dtype=bool))
    for E in cand:
        R1, R2, t = decompose_essential(E)
        for R in (R1, R2):
            for sign in (1.0, -1.0):
                tt = sign * t
                P2 = np.hstack([R, tt[:, None]])
                X = _triangulate(P1, P2, q1, q2)  # (N, 3) world = camera-1 frame
                d1 = X[:, 2]
                Xc2 = X @ R.T + tt  # depth in camera 2
                d2 = Xc2[:, 2]
                mask = (d1 > 0) & (d2 > 0)
                n = int(mask.sum())
                if n > best[0]:
                    tnorm = tt / (np.linalg.norm(tt) + 1e-15)
                    best = (n, R, tnorm, mask)
    return best[1], best[2], best[3]
