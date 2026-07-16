"""Surface-of-revolution (turned-part) reconstruction (SPEC-7 R6.4b-ii, route a).

A large, common class of MIXED-shape parts — stepped shafts, chamfered/filleted cylinders,
capped cylinders — are solids of revolution. For these the shared edges between segments are
exact circles, created automatically by OCCT's `BRepPrimAPI_MakeRevol`, so we sidestep the
fragile general surface–surface-intersection topology tail entirely.

Pipeline: section the mesh with a plane through the axis → take the ordered r≥0 half of the
cross-section as the profile → revolve it 360°. The result is SELF-VALIDATED by volume: a
true revolution reconstructs to a solid whose volume matches the mesh's; anything else
(a box, an organic blob) fails the volume gate and is rejected (→ caller falls back). All
deterministic.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import trimesh
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeRevol
from OCC.Core.gp import gp_Ax1, gp_Dir, gp_Pnt
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer

from .closure import verify_closure
from .curved_faces import SolidResult
from .detect import dominant_axis


def _plane_e1(axis: np.ndarray) -> np.ndarray:
    tmp = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    e1 = np.cross(axis, tmp)
    return e1 / np.linalg.norm(e1)


def extract_profile(mesh: trimesh.Trimesh, axis: np.ndarray) -> Optional[np.ndarray]:
    """Ordered (a, b) profile — a = axial (rel. centroid), b = radial ≥ 0 — from the mesh's
    cross-section in a plane containing the axis. None if no usable section."""
    axis = axis / np.linalg.norm(axis)
    e1 = _plane_e1(axis)
    centroid = np.asarray(mesh.centroid, dtype=float)
    section = mesh.section(plane_origin=centroid, plane_normal=np.cross(axis, e1))
    if section is None or not section.discrete:
        return None
    loop = np.asarray(max(section.discrete, key=len), dtype=float)
    rel = loop - centroid
    a = rel @ axis
    b = rel @ e1
    keep = b >= -1e-7
    if keep.all() or not keep.any():
        return None  # plane not through the axis as expected
    n = len(loop)
    first_false = int(np.where(~keep)[0][0])
    order = [(first_false + 1 + k) % n for k in range(n)]
    run = [i for i in order if keep[i]]  # contiguous +b arc, in loop order
    prof: list[tuple[float, float]] = []
    for i in run:
        za, rb = float(a[i]), float(max(b[i], 0.0))
        if not prof or abs(za - prof[-1][0]) > 1e-7 or abs(rb - prof[-1][1]) > 1e-7:
            prof.append((za, rb))
    return np.array(prof) if len(prof) >= 3 else None


def revolve_profile(profile_ab: np.ndarray, centroid: np.ndarray, axis: np.ndarray) -> SolidResult:
    """Revolve an ordered (a=axial, b=radial) profile 360° about the axis through `centroid`."""
    axis = axis / np.linalg.norm(axis)
    e1 = _plane_e1(axis)
    poly = BRepBuilderAPI_MakePolygon()
    for a_val, b_val in profile_ab:
        pt = centroid + a_val * axis + b_val * e1
        poly.Add(gp_Pnt(*pt))
    poly.Close()
    if not poly.IsDone():
        return SolidResult(poly.Shape() if poly.IsDone() else None, False, False, -1, 0.0, 0)  # type: ignore[arg-type]
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True)
    if not face.IsDone():
        return SolidResult(face.Shape(), False, False, -1, 0.0, 0)
    revolved = BRepPrimAPI_MakeRevol(face.Face(), gp_Ax1(gp_Pnt(*centroid), gp_Dir(*axis))).Shape()
    # MakeRevol shapes are born closed, but closure is VERIFIED, never assumed (FR-7):
    # real free-edge count + validity + positive volume.
    solid, rep = verify_closure(revolved)
    n_faces = 0
    exp = TopExp_Explorer(solid, TopAbs_FACE)
    while exp.More():
        n_faces += 1
        exp.Next()
    return SolidResult(solid, rep.is_solid, rep.is_valid, rep.free_edges, rep.volume, n_faces, primitive="revolution")


def reconstruct_revolution(vertices: np.ndarray, faces: np.ndarray, vol_tol: float = 0.02) -> Optional[SolidResult]:
    """If the mesh is a solid of revolution, reconstruct it as an analytic revolved solid;
    else None. Self-validated by volume: the reconstructed solid's volume must match the
    watertight mesh's within `vol_tol` (relative), which rejects non-revolutions."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    if not mesh.is_watertight:
        return None
    mesh_volume = abs(float(mesh.volume))
    if mesh_volume <= 0:
        return None
    axis = dominant_axis(mesh.face_normals)
    profile = extract_profile(mesh, axis)
    if profile is None:
        return None
    res = revolve_profile(profile, np.asarray(mesh.centroid, dtype=float), axis)
    if not res.is_solid:
        return None
    if abs(res.volume - mesh_volume) / mesh_volume > vol_tol:
        return None  # not faithfully a revolution → reject
    return res
