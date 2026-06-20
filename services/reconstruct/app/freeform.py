"""Freeform (BSpline/filled) faces for smooth non-primitive regions (SPEC-7 R6.5).

For a smooth region that fits no analytic primitive, build ONE freeform face via
`BRepOffsetAPI_MakeFilling` from the region's mesh boundary loop (as C0 edge constraints) plus
its interior vertices (as point constraints). Critically, the face's boundary IS the region's
mesh polyline — the SAME edges its planar/faceted neighbors use — so it sews with them
(coincident boundaries), while the interior is a smooth surface rather than triangles. Regions
with holes (multiple boundary loops) or that fail to fill are left to the faceted fallback, so
nothing is dropped. Deterministic (no RNG).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import trimesh
from OCC.Core.BRep import BRep_Tool
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepOffsetAPI import BRepOffsetAPI_MakeFilling
from OCC.Core.GeomAbs import GeomAbs_C0
from OCC.Core.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCC.Core.gp import gp_Pnt
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Face, topods


_MAX_INTERIOR = 10  # MakeFilling degrades/fails with many point constraints


def _first_face(shape) -> Optional[TopoDS_Face]:
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    return topods.Face(exp.Current()) if exp.More() else None


def freeform_face(boundary_loop: np.ndarray, interior_points: Optional[np.ndarray] = None) -> Optional[TopoDS_Face]:
    """A freeform face from an ordered boundary loop (the shared mesh polyline) + interior point
    constraints. Returns None if it can't be built/validated (caller falls back to faceting)."""
    pts = np.asarray(boundary_loop, dtype=float)
    if len(pts) >= 2 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    fill = BRepOffsetAPI_MakeFilling()
    for i in range(len(pts)):
        a = gp_Pnt(*pts[i])
        b = gp_Pnt(*pts[(i + 1) % len(pts)])
        edge = BRepBuilderAPI_MakeEdge(a, b)
        if not edge.IsDone():
            return None
        fill.Add(edge.Edge(), GeomAbs_C0)
    if interior_points is not None:
        for p in np.asarray(interior_points, dtype=float):
            fill.Add(gp_Pnt(float(p[0]), float(p[1]), float(p[2])))
    try:
        fill.Build()
    except Exception:  # noqa: BLE001
        return None
    if not fill.IsDone():
        return None
    face = _first_face(fill.Shape())
    if face is None or not BRepCheck_Analyzer(face).IsValid():
        return None
    return face


def freeform_region_face(mesh: trimesh.Trimesh, face_indices: np.ndarray) -> Optional[TopoDS_Face]:
    """Build a freeform face for a connected mesh region: its single outer boundary loop +
    interior vertices. None for holed (multi-loop) or unbuildable regions."""
    try:
        outline = mesh.outline(face_indices)
        loops = outline.discrete  # raises on a closed region (no boundary)
    except Exception:  # noqa: BLE001 — closed/degenerate region → not fillable as one patch
        return None
    if loops is None or len(loops) != 1:
        return None  # closed (no loop) or holed (multi-loop) → faceted fallback
    loop = np.asarray(loops[0], dtype=float)
    boundary = loop[:-1] if (len(loop) >= 2 and np.allclose(loop[0], loop[-1])) else loop
    if len(boundary) < 3:
        return None
    region_v = mesh.vertices[np.unique(mesh.faces[face_indices])]
    bset = {tuple(np.round(p, 7)) for p in boundary}
    interior = np.array([v for v in region_v if tuple(np.round(v, 7)) not in bset], dtype=float)
    # MakeFilling is an energy-minimizing fill that fails / degrades with many point
    # constraints; subsample the interior to a tractable, deterministic set (evenly strided).
    if len(interior) > _MAX_INTERIOR:
        interior = interior[:: max(1, len(interior) // _MAX_INTERIOR)][:_MAX_INTERIOR]
    return freeform_face(boundary, interior if len(interior) else None)


def face_max_point_error(face: TopoDS_Face, points: np.ndarray) -> float:
    """Max distance from `points` to the face's surface (fit-quality check)."""
    surf = BRep_Tool.Surface(face)
    worst = 0.0
    for p in np.asarray(points, dtype=float):
        proj = GeomAPI_ProjectPointOnSurf(gp_Pnt(float(p[0]), float(p[1]), float(p[2])), surf)
        if proj.NbPoints() > 0:
            worst = max(worst, float(proj.LowerDistance()))
    return worst
