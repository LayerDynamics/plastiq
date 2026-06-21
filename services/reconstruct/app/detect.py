"""Deterministic primitive-region detection (SPEC-7 R6.4).

R6.4a detects the dominant cylindrical region of a mesh via the Gauss map: a cylinder's face
normals are all perpendicular to its axis, so the axis is the direction ⊥ to the whole normal
set (smallest right-singular vector), and the cylinder's side faces are those whose normal is
(near-)perpendicular to that axis. General multi-primitive seeded region-growing (sphere/cone,
mixed parts) is R6.4b. Deterministic (SVD + fixed threshold), per NFR-2.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import trimesh

from .curved_faces import SolidResult, cone_solid, cylinder_solid, sphere_solid
from .primitives import fit_cone, fit_cylinder, fit_sphere


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


def cone_side_faces(mesh: trimesh.Trimesh, axis: np.ndarray, base_tol: float = 0.95) -> np.ndarray:
    """Boolean mask of a cone's lateral faces: everything except the base cap (whose normal
    is ~parallel to the axis, |n·axis| ≈ 1)."""
    fn = np.asarray(mesh.face_normals, dtype=float)
    return np.abs(fn @ axis) < base_tol


def reconstruct_sphere(vertices: np.ndarray, faces: np.ndarray) -> SolidResult:
    """A single-sphere mesh → a watertight analytic sphere solid."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    return sphere_solid(fit_sphere(mesh.vertices))


def reconstruct_cone(vertices: np.ndarray, faces: np.ndarray) -> SolidResult:
    """A single-cone mesh → a watertight analytic cone solid (lateral fit; base excluded)."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    axis = dominant_axis(mesh.face_normals)
    side = cone_side_faces(mesh, axis)
    if side.sum() < 2:
        raise ValueError("no conical side region detected")
    sv = mesh.vertices[np.unique(mesh.faces[side])]
    return cone_solid(fit_cone(sv, mesh.face_normals[side]))


def _plane_basis(axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    tmp = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    e1 = np.cross(axis, tmp)
    e1 = e1 / np.linalg.norm(e1)
    return e1, np.cross(axis, e1)


def _max_angular_gap(normals: np.ndarray, axis: np.ndarray) -> float:
    """Largest angular gap (radians) between consecutive normals projected around `axis`. A
    cylinder/cone wraps densely (small gap); a prism leaves big gaps between its few flats."""
    e1, e2 = _plane_basis(axis)
    proj = normals - np.outer(normals @ axis, axis)
    proj = proj[np.linalg.norm(proj, axis=1) > 1e-6]
    if len(proj) < 3:
        return 2 * np.pi
    ang = np.sort(np.arctan2(proj @ e2, proj @ e1))
    gaps = np.diff(np.concatenate([ang, [ang[0] + 2 * np.pi]]))
    return float(gaps.max())


def _n_distinct_normals(normals: np.ndarray, cos_tol: float = 0.99) -> int:
    """Count distinct face-normal directions (greedy clustering). A box has ~6; a curved
    primitive has many — this rejects boxes/prisms whose corners happen to lie on a
    circumscribed sphere/circle."""
    n = normals / np.linalg.norm(normals, axis=1, keepdims=True)
    kept: list[np.ndarray] = []
    for row in n:
        if all(abs(float(row @ k)) < cos_tol for k in kept):
            kept.append(row)
    return len(kept)


# A curved primitive's side wraps the axis with no big flat gaps; a prism does not.
_MAX_GAP = np.radians(50.0)
_MIN_SPHERE_NORMALS = 16  # a sphere shows many normal directions; a box shows ~6


def _volume_ok(mesh: trimesh.Trimesh, res: SolidResult, tol: float) -> bool:
    """The analytic solid must reproduce the mesh's volume. This REJECTS a *partial* primitive
    — e.g. an oblique-cut or flat-sided ("D-shaft") cylinder whose side vertices lie perfectly
    on the cylinder (near-zero RMS) but whose true shape is NOT the full primitive: building
    the full cylinder/sphere/cone would silently invent volume. (Without this check such a part
    is mis-reconstructed as a full primitive — it routes to the cut-cylinder/fitted paths
    instead.) An open mesh can't be volume-checked, so the RMS + shape gate stands."""
    if not mesh.is_volume:
        return True
    mv = float(mesh.volume)
    if mv <= 0:
        return True
    return abs(res.volume - mv) / mv < tol


def try_single_primitive(
    vertices: np.ndarray, faces: np.ndarray, rel_tol: float = 0.02, vol_tol: float = 0.05
) -> Optional[SolidResult]:
    """Deterministically test whether the whole mesh is a single analytic primitive
    (sphere / cylinder / cone) and, if so, return its watertight solid. Beyond a low
    size-relative RMS residual, a candidate must pass a SHAPE gate (angular coverage for
    cylinder/cone; distinct-normal count for sphere) so a box — whose corners lie on a
    circumscribed circle/sphere — is NOT misread as a primitive, AND a VOLUME gate so a partial
    primitive (oblique-cut / flat-sided cylinder) isn't rebuilt as a full one. Returns None if
    nothing qualifies; the caller falls back to the planar/faceted path. Must be a valid solid."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    fn = np.asarray(mesh.face_normals, dtype=float)
    candidates: list[tuple[str, float, SolidResult]] = []

    # Sphere — all vertices; gate on many distinct normal directions (curvature everywhere).
    try:
        if _n_distinct_normals(fn) >= _MIN_SPHERE_NORMALS:
            sf = fit_sphere(mesh.vertices)
            if sf.radius > 0:
                candidates.append(("sphere", sf.rms / sf.radius, sphere_solid(sf)))
    except Exception:  # noqa: BLE001 — a failed hypothesis is simply not a candidate
        pass

    # Cylinder + cone — the lateral region about the dominant axis; gate on angular coverage.
    try:
        axis = dominant_axis(fn)
        cyl_side = cylinder_side_faces(mesh, axis)
        if cyl_side.sum() >= 3 and _max_angular_gap(fn[cyl_side], axis) < _MAX_GAP:
            sv = mesh.vertices[np.unique(mesh.faces[cyl_side])]
            cyl = fit_cylinder(sv, fn[cyl_side])
            if cyl.radius > 0:
                candidates.append(("cylinder", cyl.rms / cyl.radius, cylinder_solid(cyl)))
        cone_side = cone_side_faces(mesh, axis)
        if cone_side.sum() >= 3 and _max_angular_gap(fn[cone_side], axis) < _MAX_GAP:
            cv = mesh.vertices[np.unique(mesh.faces[cone_side])]
            cone = fit_cone(cv, fn[cone_side])
            if cone.base_radius > 0:
                candidates.append(("cone", cone.rms / cone.base_radius, cone_solid(cone)))
    except Exception:  # noqa: BLE001
        pass

    good = [
        (name, err, res)
        for name, err, res in candidates
        if err < rel_tol and res.is_solid and _volume_ok(mesh, res, vol_tol)
    ]
    if not good:
        return None
    good.sort(key=lambda c: c[1])  # smallest relative residual wins (deterministic)
    best = good[0][2]
    best.primitive = good[0][0]
    return best
