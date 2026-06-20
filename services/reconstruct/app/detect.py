"""Deterministic primitive-region detection (SPEC-7 R6.4).

R6.4a detects the dominant cylindrical region of a mesh via the Gauss map: a cylinder's face
normals are all perpendicular to its axis, so the axis is the direction ⊥ to the whole normal
set (smallest right-singular vector), and the cylinder's side faces are those whose normal is
(near-)perpendicular to that axis. General multi-primitive seeded region-growing (sphere/cone,
mixed parts) is R6.4b. Deterministic (SVD + fixed threshold), per NFR-2.
"""

from __future__ import annotations

import numpy as np
import trimesh

from .curved_faces import SolidResult, cylinder_solid
from .primitives import fit_cylinder


def dominant_axis(face_normals: np.ndarray, align_tol: float = 0.99) -> np.ndarray:
    """The cylinder/prism axis = the dominant normal-cluster direction. A cylinder's caps are
    fans of faces sharing the exact ±axis normal, so ±axis is the most-aligned normal
    direction; each side normal is shared by only a couple of faces. (A global SVD fails here:
    the cap normals lie ALONG the axis, giving the axis direction the MOST spread, so the
    smallest singular vector lands perpendicular to the true axis.) Deterministic: first max
    wins under fixed face order. Returns the candidate normal with the most aligned faces."""
    n = np.asarray(face_normals, dtype=float)
    n = n / np.linalg.norm(n, axis=1, keepdims=True)
    aligned = np.abs(n @ n.T) > align_tol  # (F,F): faces parallel to each candidate
    counts = aligned.sum(axis=1)
    best = int(np.argmax(counts))  # argmax returns the FIRST max → deterministic
    axis = n[best]
    return axis / np.linalg.norm(axis)


def cylinder_side_faces(mesh: trimesh.Trimesh, axis: np.ndarray, perp_tol: float = 0.35) -> np.ndarray:
    """Boolean face mask of the cylindrical side: faces whose normal is ~perpendicular to
    `axis` (|n·axis| < perp_tol)."""
    fn = np.asarray(mesh.face_normals, dtype=float)
    return np.abs(fn @ axis) < perp_tol


def reconstruct_cylinder(vertices: np.ndarray, faces: np.ndarray) -> SolidResult:
    """End-to-end (R6.4a): a single-cylinder mesh → a watertight analytic cylinder solid.
    Detect the side region (Gauss map), fit the cylinder deterministically, build the solid
    with analytic caps sharing the exact rim circles."""
    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=float),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    axis = dominant_axis(mesh.face_normals)
    side = cylinder_side_faces(mesh, axis)
    if side.sum() < 2:
        raise ValueError("no cylindrical side region detected")
    side_vertices = mesh.vertices[np.unique(mesh.faces[side])]
    fit = fit_cylinder(side_vertices, mesh.face_normals[side])
    return cylinder_solid(fit)
