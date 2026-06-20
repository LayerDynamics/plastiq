"""Analytic-face reconstruction (R6.4).

Collapses each planar facet (R6.3) into ONE trimmed OCCT planar face built from the
facet's boundary loop, instead of one face per triangle — a clean, compact B-rep for the
flat regions of a part. Facets with holes (multiple boundary loops) or that fail to build,
and triangles in no facet, fall back to per-triangle faces (R6.1) so nothing is dropped.
All faces are sewn into a shell and a solid when watertight. Curved-surface fitting
(cylinders/spheres → single analytic faces) is a later milestone; curved regions arrive
here as their planar sub-facets.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import trimesh
from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
)
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.gp import gp_Pnt
from OCC.Core.TopAbs import TopAbs_SHELL
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Face, TopoDS_Shape, topods

from .segment import planar_segments


@dataclass
class FittedResult:
    shape: TopoDS_Shape
    triangles_in: int
    planar_faces: int
    triangle_faces: int
    is_solid: bool
    is_valid: bool


def _planar_face_from_loop(points: np.ndarray) -> TopoDS_Face | None:
    """A single trimmed planar OCCT face from an ordered boundary loop (closing-point
    duplicate tolerated). Returns None if it can't be built (caller falls back)."""
    pts = points
    if len(pts) >= 2 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    poly = BRepBuilderAPI_MakePolygon()
    for p in pts:
        poly.Add(gp_Pnt(float(p[0]), float(p[1]), float(p[2])))
    poly.Close()
    if not poly.IsDone():
        return None
    maker = BRepBuilderAPI_MakeFace(poly.Wire(), True)  # planeOnly=True
    return maker.Face() if maker.IsDone() else None


def _triangle_face(vertices: np.ndarray, tri: np.ndarray) -> TopoDS_Face | None:
    p0 = gp_Pnt(float(vertices[tri[0], 0]), float(vertices[tri[0], 1]), float(vertices[tri[0], 2]))
    p1 = gp_Pnt(float(vertices[tri[1], 0]), float(vertices[tri[1], 1]), float(vertices[tri[1], 2]))
    p2 = gp_Pnt(float(vertices[tri[2], 0]), float(vertices[tri[2], 1]), float(vertices[tri[2], 2]))
    poly = BRepBuilderAPI_MakePolygon(p0, p1, p2, True)
    if not poly.IsDone():
        return None
    maker = BRepBuilderAPI_MakeFace(poly.Wire(), True)
    return maker.Face() if maker.IsDone() else None


def fitted_shape(vertices: np.ndarray, faces: np.ndarray, sew_tol: float = 1e-6) -> FittedResult:
    """Reconstruct planar facets into single trimmed faces (faceted fallback otherwise)."""
    mesh, facets, leftover = planar_segments(vertices, faces)
    verts = np.asarray(mesh.vertices, dtype=float)
    sewing = BRepBuilderAPI_Sewing(sew_tol)
    planar = 0
    tri_faces = 0

    def _add_triangles(face_indices: np.ndarray) -> None:
        nonlocal tri_faces
        for fi in face_indices:
            tf = _triangle_face(verts, mesh.faces[fi])
            if tf is not None:
                sewing.Add(tf)
                tri_faces += 1

    for fac in facets:
        loops = mesh.outline(fac).discrete
        face = _planar_face_from_loop(loops[0]) if len(loops) == 1 else None
        if face is not None:
            sewing.Add(face)
            planar += 1
        else:
            _add_triangles(fac)  # holed/unbuildable facet → keep its triangles
    _add_triangles(leftover)  # triangles in no facet

    if planar + tri_faces == 0:
        raise ValueError("no faces could be built from the mesh")

    sewing.Perform()
    sewn = sewing.SewedShape()

    solid_maker = BRepBuilderAPI_MakeSolid()
    shells = 0
    exp = TopExp_Explorer(sewn, TopAbs_SHELL)
    while exp.More():
        solid_maker.Add(topods.Shell(exp.Current()))
        shells += 1
        exp.Next()

    if shells > 0 and solid_maker.IsDone():
        solid = solid_maker.Solid()
        if BRepCheck_Analyzer(solid).IsValid():
            return FittedResult(solid, len(faces), planar, tri_faces, True, True)

    return FittedResult(sewn, len(faces), planar, tri_faces, False, BRepCheck_Analyzer(sewn).IsValid())
