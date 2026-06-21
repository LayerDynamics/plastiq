"""Freeform (BSpline/filled) faces for smooth non-primitive regions (SPEC-7 R6.5).

For a smooth region that fits no analytic primitive, build ONE freeform face via
`BRepOffsetAPI_MakeFilling` from the region's mesh boundary loop (as C0 edge constraints) plus
its interior vertices (as point constraints). Critically, the face's boundary IS the region's
mesh polyline — the SAME edges its planar/faceted neighbors use — so it sews with them
(coincident boundaries), while the interior is a smooth surface rather than triangles. Regions
with holes (multiple boundary loops) or that fail to fill are left to the faceted fallback, so
nothing is dropped. Deterministic (no RNG).

`freeform_capped_solid` takes that coincident-boundary property to its conclusion: planar side
faces + a freeform cap that shares their rim sew into a WATERTIGHT solid. The same idea is
wired into the reconstruction pipeline by `fitted.py`, which collapses each single-loop
non-planar mesh region into one freeform face alongside the planar facets. Genuinely open
cases remain: a CLOSED region has no boundary loop so it can't be one filled patch (a whole
organic blob stays faceted — a fundamental limit), and the analytic-rim *sagitta* mismatch (a
smooth fitted arc vs a faceted polyline neighbour) still needs the surface-intersection tail.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import trimesh
from OCC.Core.BRep import BRep_Tool
from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
)
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepGProp import brepgprop
from OCC.Core.BRepLib import breplib
from OCC.Core.BRepOffsetAPI import BRepOffsetAPI_MakeFilling
from OCC.Core.GeomAbs import GeomAbs_C0
from OCC.Core.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCC.Core.GProp import GProp_GProps
from OCC.Core.gp import gp_Pnt
from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_SHELL
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Face, topods

from .curved_faces import SolidResult


# MakeFilling accuracy improves markedly with more interior constraints (a sphere cap:
# ~2600 µm error at 10 points vs ~70 µm with the full set), but it is NOT monotonically
# robust — some counts fail to build while neighbours succeed — and it slows on large sets.
# So `freeform_region_face` tries a LADDER of counts (richest first, capped for tractability)
# and returns the first face that builds, giving the best accuracy that's also robust.
_INTERIOR_LADDER = (200, 100, 50, 25, 10)


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
    if len(interior) == 0:
        return freeform_face(boundary, None)
    # Try the richest (most accurate) interior set first, stepping down on a MakeFilling
    # failure (deterministic even strides). Returns the most accurate face that builds.
    for k in _INTERIOR_LADDER:
        sub = interior if len(interior) <= k else interior[:: max(1, len(interior) // k)][:k]
        face = freeform_face(boundary, sub)
        if face is not None:
            return face
    return None


def _planar_face(loop: np.ndarray) -> Optional[TopoDS_Face]:
    """A planar polygon face from an ordered boundary loop."""
    pts = np.asarray(loop, dtype=float)
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
    mk = BRepBuilderAPI_MakeFace(poly.Wire(), True)
    return mk.Face() if mk.IsDone() else None


def _faces_in(shape) -> int:
    n = 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        n += 1
        exp.Next()
    return n


def freeform_capped_solid(
    side_loops: list[np.ndarray],
    cap_boundary: np.ndarray,
    cap_interior: Optional[np.ndarray] = None,
    sew_tol: float = 1e-6,
) -> Optional[SolidResult]:
    """Build a WATERTIGHT solid from planar side faces + ONE freeform cap that SHARES its
    boundary with them (SPEC-7 R6.5 topology integration). This is the case where freeform
    really joins a solid: the cap's boundary is the same mesh polyline (straight segments) the
    planar neighbours use, so the boundaries coincide and sewing at a tight tolerance closes
    the shell — `NbFreeEdges()==0`. (Contrast the open sagitta case: a smooth ANALYTIC rim —
    e.g. a circle — deviates from a faceted neighbour's polyline by the sagitta, far above the
    sew tolerance; that still needs the surface-intersection tail and is out of scope.)

    Returns a volume-/closure-validated SolidResult, or None if it can't close (caller keeps
    the faceted solid — nothing is dropped). Deterministic."""
    faces: list[TopoDS_Face] = []
    for loop in side_loops:
        f = _planar_face(loop)
        if f is None:
            return None
        faces.append(f)
    cap = freeform_face(cap_boundary, cap_interior)
    if cap is None:
        return None
    faces.append(cap)

    sew = BRepBuilderAPI_Sewing(sew_tol)
    for f in faces:
        sew.Add(f)
    sew.Perform()
    if sew.NbFreeEdges() != 0:
        return None  # not watertight → caller falls back (no fragile output)
    shape = sew.SewedShape()
    if shape.ShapeType() != TopAbs_SHELL:
        return None
    solid = BRepBuilderAPI_MakeSolid(topods.Shell(shape)).Solid()
    breplib.OrientClosedSolid(solid)  # ensure outward orientation (positive volume)
    if not BRepCheck_Analyzer(solid).IsValid():
        return None
    props = GProp_GProps()
    brepgprop.VolumeProperties(solid, props)
    volume = float(props.Mass())
    if volume <= 0:
        return None
    return SolidResult(solid, True, True, 0, volume, _faces_in(solid), primitive="freeform")


def face_max_point_error(face: TopoDS_Face, points: np.ndarray) -> float:
    """Max distance from `points` to the face's surface (fit-quality check)."""
    surf = BRep_Tool.Surface(face)
    worst = 0.0
    for p in np.asarray(points, dtype=float):
        proj = GeomAPI_ProjectPointOnSurf(gp_Pnt(float(p[0]), float(p[1]), float(p[2])), surf)
        if proj.NbPoints() > 0:
            worst = max(worst, float(proj.LowerDistance()))
    return worst
