"""Faceted mesh→B-rep: every triangle becomes a planar OCCT face, sewn into a shell and
(when watertight) a solid.

This is the baseline reconstruction (R6.1): it always produces a valid B-rep STEP shape
from any triangle soup, with no surface fitting. R6.3/R6.4 add RANSAC primitive detection
to COLLAPSE fitted regions (planes, cylinders, …) into single analytic faces — a clean,
editable reconstruction — replacing the per-triangle faces for those regions. Until then
the faceted shape is the honest, complete result (a real B-rep, just dense).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
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
from OCC.Core.TopoDS import TopoDS_Shape, topods


@dataclass
class FacetedResult:
    shape: TopoDS_Shape
    triangles_in: int
    faces_built: int
    is_solid: bool
    is_valid: bool


def _nondegenerate_mask(vertices: np.ndarray, faces: np.ndarray, area2_tol: float = 1e-20) -> np.ndarray:
    """Boolean mask of triangles with non-zero area (skip slivers that can't form a face)."""
    v0 = vertices[faces[:, 0]]
    v1 = vertices[faces[:, 1]]
    v2 = vertices[faces[:, 2]]
    cross = np.cross(v1 - v0, v2 - v0)
    area2 = np.einsum("ij,ij->i", cross, cross)  # (2*area)^2
    return area2 > area2_tol


def faceted_shape(vertices: np.ndarray, faces: np.ndarray, sew_tol: float = 1e-6) -> FacetedResult:
    """Build a sewn B-rep shape from a triangle mesh. Coordinates are used as-is (SI
    metres, matching @plastiq/cad's STEP I/O) so the result round-trips through importStep."""
    good = faces[_nondegenerate_mask(vertices, faces)]
    sewing = BRepBuilderAPI_Sewing(sew_tol)
    built = 0
    for tri in good:
        p0 = gp_Pnt(float(vertices[tri[0], 0]), float(vertices[tri[0], 1]), float(vertices[tri[0], 2]))
        p1 = gp_Pnt(float(vertices[tri[1], 0]), float(vertices[tri[1], 1]), float(vertices[tri[1], 2]))
        p2 = gp_Pnt(float(vertices[tri[2], 0]), float(vertices[tri[2], 1]), float(vertices[tri[2], 2]))
        poly = BRepBuilderAPI_MakePolygon(p0, p1, p2, True)
        if not poly.IsDone():
            continue
        face_maker = BRepBuilderAPI_MakeFace(poly.Wire(), True)
        if not face_maker.IsDone():
            continue
        sewing.Add(face_maker.Face())
        built += 1

    if built == 0:
        raise ValueError("no valid triangles to build B-rep faces from")

    sewing.Perform()
    sewn = sewing.SewedShape()

    # Assemble a solid from the sewn shell(s) when the mesh is watertight; otherwise
    # keep the open shell (STEP holds either). Validity is checked, never assumed.
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
            return FacetedResult(solid, len(faces), built, True, True)

    return FacetedResult(sewn, len(faces), built, False, BRepCheck_Analyzer(sewn).IsValid())
