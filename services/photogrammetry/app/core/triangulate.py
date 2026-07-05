"""Two-view triangulation: linear DLT + cheirality / reprojection / parallax gates.

Given two camera projection matrices ``P1, P2`` (3x4, ``P = K[R|t]`` in the OpenCV / +z-forward solver
frame SPEC-13 uses) and pixel correspondences ``pts1, pts2`` ((N, 2)), ``triangulate`` reconstructs the
world points ``X`` ((N, 3)) by the Direct Linear Transform: each correspondence contributes four rows
to a 4x4 constraint matrix ``A`` (``x·P[2] - P[0]``, ``y·P[2] - P[1]`` per view), and the homogeneous
point is the right null vector of ``A`` — found as the eigenvector of ``AᵀA`` for its smallest
eigenvalue (``eigh``; algebraically the last right singular vector of ``A``), then dehomogenised.

Three independent gates score a triangulated point (each a boolean mask (N,), so callers can compose or
inspect them separately — the SPEC-13 §5.4-4 mapper filters):

- ``cheirality_mask`` — positive camera-space depth in BOTH views (in front of both cameras). Uses the
  Hartley/Zisserman signed depth ``sign(det M)·(P[2]·X̃)`` with ``M = P[:, :3]``.
- ``reprojection_mask`` — the point reprojects to within ``max_px`` (default 4.0, §5.4-4) of its
  observation in BOTH views (L2 pixel error).
- ``parallax_mask`` — the triangulation angle at ``X`` between the two viewing rays (from each camera
  centre ``C = -M⁻¹ p4``) is at least ``min_deg`` (default 1.5°, §5.4-4); low-parallax points are
  ill-conditioned in depth and rejected.

``triangulate_gated`` triangulates then returns ``(X, valid)`` where ``valid`` is the AND of all three.

Numerics (docs/adr/0013 D-9): pure float64 numpy on the CPU — the sparse/combinatorial solver tier,
deterministic (a fixed-size ``eigh`` carries no RNG) and MLX-free. OpenCV is a *test-only* oracle (D-1)
and is never imported here.

Algorithm reimplemented (no code copied) with attribution from kornia (Apache-2.0):
``kornia/geometry/epipolar/triangulation.py::triangulate_points`` (the ``eigh`` DLT formulation) — which
follows Hartley & Zisserman, *Multiple View Geometry*, 2nd ed. §12.2 (DLT triangulation).
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "triangulate",
    "cheirality_mask",
    "reprojection_mask",
    "parallax_mask",
    "triangulate_gated",
]


def _as_projection(P) -> np.ndarray:
    """Validate/copy a single ``(3, 4)`` float64 projection matrix."""
    p = np.asarray(P, dtype=np.float64)
    if p.shape != (3, 4):
        raise ValueError(f"projection matrix must have shape (3, 4); got {p.shape}")
    return p


def _as_points(points) -> np.ndarray:
    """Validate/copy an ``(N, 2)`` float64 array of image points."""
    p = np.asarray(points, dtype=np.float64)
    if p.ndim != 2 or p.shape[-1] != 2:
        raise ValueError(f"points must have shape (N, 2); got {p.shape}")
    return p


def _as_world(X) -> np.ndarray:
    """Validate/copy an ``(N, 3)`` float64 array of world points."""
    x = np.asarray(X, dtype=np.float64)
    if x.ndim != 2 or x.shape[-1] != 3:
        raise ValueError(f"world points must have shape (N, 3); got {x.shape}")
    return x


def _homogeneous(X: np.ndarray) -> np.ndarray:
    """``(N, 3)`` → ``(N, 4)`` by appending a column of ones."""
    return np.concatenate([X, np.ones((X.shape[0], 1), dtype=np.float64)], axis=1)


def _camera_center(P: np.ndarray) -> np.ndarray:
    """Camera centre ``C`` (world coords): the point with ``P [C; 1]ᵀ = 0``, i.e. ``C = -M⁻¹ p4``."""
    M, p4 = P[:, :3], P[:, 3]
    return -np.linalg.solve(M, p4)


def _signed_depths(P: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Hartley/Zisserman signed depth of each ``X`` in camera ``P``: ``sign(det M)·(P[2]·X̃)``.

    For a metric ``P = K[R|t]`` (``det M > 0``) this equals the camera-space z-coordinate, so the sign
    is the cheirality (positive ⇔ in front of the camera)."""
    Xh = _homogeneous(_as_world(X))
    s = np.sign(np.linalg.det(P[:, :3]))
    return s * (Xh @ P[2, :])


def _reproject(P: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Project world points ``(N, 3)`` through ``P`` → pixel coordinates ``(N, 2)``."""
    proj = _homogeneous(_as_world(X)) @ P.T  # (N, 3)
    return proj[:, :2] / proj[:, 2:3]


def triangulate(P1, P2, pts1, pts2) -> np.ndarray:
    """Linear DLT triangulation of ``(N, 2)`` correspondences from two ``(3, 4)`` cameras → ``(N, 3)``.

    Each correspondence yields a 4x4 DLT constraint matrix; the homogeneous world point is the
    eigenvector of ``AᵀA`` for its smallest eigenvalue (equivalently ``A``'s last right singular
    vector), then dehomogenised. Batched over all ``N`` correspondences.
    """
    P1 = _as_projection(P1)
    P2 = _as_projection(P2)
    pts1 = _as_points(pts1)
    pts2 = _as_points(pts2)
    if pts1.shape[0] != pts2.shape[0]:
        raise ValueError(f"pts1 and pts2 must have equal length; got {pts1.shape[0]} vs {pts2.shape[0]}")

    # Four DLT rows per correspondence (Hartley/Zisserman §12.2): x·P[2] - P[0], y·P[2] - P[1] per view.
    row0 = pts1[:, 0:1] * P1[2:3, :] - P1[0:1, :]  # (N, 4)
    row1 = pts1[:, 1:2] * P1[2:3, :] - P1[1:2, :]
    row2 = pts2[:, 0:1] * P2[2:3, :] - P2[0:1, :]
    row3 = pts2[:, 1:2] * P2[2:3, :] - P2[1:2, :]
    A = np.stack([row0, row1, row2, row3], axis=1)  # (N, 4, 4)

    ata = np.matmul(np.transpose(A, (0, 2, 1)), A)  # (N, 4, 4), symmetric PSD
    # eigh returns eigenvalues ascending; the smallest-eigenvalue eigenvector is column 0.
    _, vecs = np.linalg.eigh(ata)
    Xh = vecs[:, :, 0]  # (N, 4), homogeneous world points
    return Xh[:, :3] / Xh[:, 3:4]


def cheirality_mask(P1, P2, X) -> np.ndarray:
    """Boolean ``(N,)`` mask: ``True`` where ``X`` has positive depth in BOTH cameras."""
    P1 = _as_projection(P1)
    P2 = _as_projection(P2)
    X = _as_world(X)
    return (_signed_depths(P1, X) > 0.0) & (_signed_depths(P2, X) > 0.0)


def reprojection_mask(P1, P2, pts1, pts2, X, max_px: float = 4.0) -> np.ndarray:
    """Boolean ``(N,)`` mask: ``True`` where ``X`` reprojects within ``max_px`` in BOTH views."""
    P1 = _as_projection(P1)
    P2 = _as_projection(P2)
    pts1 = _as_points(pts1)
    pts2 = _as_points(pts2)
    X = _as_world(X)
    err1 = np.linalg.norm(_reproject(P1, X) - pts1, axis=1)
    err2 = np.linalg.norm(_reproject(P2, X) - pts2, axis=1)
    return (err1 <= max_px) & (err2 <= max_px)


def parallax_mask(P1, P2, X, min_deg: float = 1.5) -> np.ndarray:
    """Boolean ``(N,)`` mask: ``True`` where the triangulation angle at ``X`` is ≥ ``min_deg``.

    The angle is between the two viewing rays ``C1 → X`` and ``C2 → X`` (camera centres ``C = -M⁻¹ p4``);
    small angles mean the depth is poorly constrained, so such points are rejected."""
    P1 = _as_projection(P1)
    P2 = _as_projection(P2)
    X = _as_world(X)
    r1 = X - _camera_center(P1)  # (N, 3)
    r2 = X - _camera_center(P2)
    r1 /= np.linalg.norm(r1, axis=1, keepdims=True)
    r2 /= np.linalg.norm(r2, axis=1, keepdims=True)
    cos = np.clip(np.sum(r1 * r2, axis=1), -1.0, 1.0)
    return np.degrees(np.arccos(cos)) >= min_deg


def triangulate_gated(P1, P2, pts1, pts2, max_px: float = 4.0, min_deg: float = 1.5):
    """Triangulate, then return ``(X (N, 3), valid (N,))`` — ``valid`` = cheirality ∧ reproj ∧ angle."""
    X = triangulate(P1, P2, pts1, pts2)
    valid = (
        cheirality_mask(P1, P2, X)
        & reprojection_mask(P1, P2, pts1, pts2, X, max_px=max_px)
        & parallax_mask(P1, P2, X, min_deg=min_deg)
    )
    return X, valid
