"""Deterministic primitive fitting (SPEC-7 R6.4).

Closed-form least-squares fits from a region's on-surface vertices + face normals — NO
randomized RANSAC, so a given region always yields the same parameters (NFR-2). R6.4a ships
the cylinder; sphere/cone follow in R6.4b.

Cylinder fit rationale (verified): a cylinder's surface normals are all perpendicular to its
axis, so the axis is the direction ⊥ to every normal — the right-singular vector of smallest
singular value of the (clean, radial) FACE-normal matrix. Radius/center/axial-extent come
from the on-surface VERTICES (which lie exactly on the cylinder) via a Kåsa algebraic circle
fit in the plane ⊥ axis. Face normals (not vertex normals) drive the axis because a cylinder
band's vertex normals are rim-averaged with the caps and tilt off-radial.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class CylinderFit:
    center: np.ndarray  # a point on the axis (3,)
    axis: np.ndarray  # unit axis direction (3,)
    radius: float
    vmin: float  # axial parameter extent relative to `center`, along `axis`
    vmax: float
    rms: float  # RMS radial residual of the vertices (fit quality)

    @property
    def height(self) -> float:
        return self.vmax - self.vmin


def _orthonormal_basis(axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Two unit vectors spanning the plane perpendicular to `axis` (deterministic)."""
    tmp = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    e1 = np.cross(axis, tmp)
    e1 = e1 / np.linalg.norm(e1)
    e2 = np.cross(axis, e1)
    return e1, e2


def fit_cylinder(vertices: np.ndarray, face_normals: np.ndarray) -> CylinderFit:
    """Fit a cylinder to a region. `face_normals` (clean radial face normals) determine the
    axis; `vertices` (on-surface) determine radius/center/axial-extent. Deterministic."""
    v = np.asarray(vertices, dtype=float)
    fn = np.asarray(face_normals, dtype=float)
    if len(v) < 3 or len(fn) < 2:
        raise ValueError("cylinder fit needs >=3 vertices and >=2 face normals")

    n = fn / np.linalg.norm(fn, axis=1, keepdims=True)
    # axis ⊥ to all surface normals → smallest right-singular vector of the normal matrix.
    _, _, vt = np.linalg.svd(n, full_matrices=False)
    axis = vt[-1]
    axis = axis / np.linalg.norm(axis)

    e1, e2 = _orthonormal_basis(axis)
    c0 = v.mean(axis=0)
    p = v - c0
    x = p @ e1
    y = p @ e2
    # Kåsa algebraic circle fit: x²+y² ≈ 2·cx·x + 2·cy·y + c
    a_mat = np.column_stack([2 * x, 2 * y, np.ones_like(x)])
    b_vec = x * x + y * y
    cx, cy, c = np.linalg.lstsq(a_mat, b_vec, rcond=None)[0]
    radius = float(np.sqrt(max(c + cx * cx + cy * cy, 0.0)))
    center = c0 + cx * e1 + cy * e2

    t = (v - center) @ axis
    radial = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    rms = float(np.sqrt(np.mean((radial - radius) ** 2)))
    return CylinderFit(center=center, axis=axis, radius=radius, vmin=float(t.min()), vmax=float(t.max()), rms=rms)
