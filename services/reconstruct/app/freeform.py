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

import logging
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
from OCC.Core.BRepOffsetAPI import BRepOffsetAPI_MakeFilling
from OCC.Core.GeomAbs import GeomAbs_C0
from OCC.Core.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCC.Core.gp import gp_Pnt
from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_SHELL
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Face, topods

from . import nurbs_delegate
from .closure import verify_closure
from .curved_faces import SolidResult

logger = logging.getLogger(__name__)


# MakeFilling accuracy improves markedly with more interior constraints (a sphere cap:
# ~2600 µm error at 10 points vs ~70 µm with the full set), but it is NOT monotonically
# robust — some counts fail to build while neighbours succeed — and it slows on large sets.
# So `freeform_region_face` tries a LADDER of counts (richest first, capped for tractability)
# and returns the first face that builds, giving the best accuracy that's also robust.
_INTERIOR_LADDER = (200, 100, 50, 25, 10)


def _first_face(shape) -> Optional[TopoDS_Face]:
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    return topods.Face(exp.Current()) if exp.More() else None


def freeform_face(
    boundary_loop: np.ndarray,
    interior_points: Optional[np.ndarray] = None,
    errors: Optional[list[str]] = None,
) -> Optional[TopoDS_Face]:
    """A freeform face from an ordered boundary loop (the shared mesh polyline) + interior point
    constraints. Returns None if it can't be built/validated (caller falls back to faceting).

    `errors` (7-L2): an optional collector a swallowed `MakeFilling.Build` crash is appended to,
    so the caller can tell a clean decline (None, nothing collected) from a swallowed crash
    (None, message collected). Fallback behavior is unchanged either way."""
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
    except Exception as e:  # noqa: BLE001 — MakeFilling can raise on hard constraint sets; the
        # crash is logged (debug: the interior-ladder retries make it common)…
        logger.debug("MakeFilling raised (%s: %s); falling back", type(e).__name__, e)
        if errors is not None:  # …and surfaced to the caller's collector (7-L2), then the
            # caller falls back (FR-8). The ladder in `freeform_region_face` only FLUSHES these
            # upward when every rung failed, so a retried-then-successful build stays clean.
            errors.append(f"MakeFilling: {type(e).__name__}: {e}")
        return None
    if not fill.IsDone():
        return None
    face = _first_face(fill.Shape())
    if face is None or not BRepCheck_Analyzer(face).IsValid():
        return None
    return face


def freeform_region_face(
    mesh: trimesh.Trimesh,
    face_indices: np.ndarray,
    errors: Optional[list[str]] = None,
) -> Optional[TopoDS_Face]:
    """Build a freeform face for a connected mesh region: its single outer boundary loop +
    interior vertices. None for holed (multi-loop) or unbuildable regions.

    `errors` (7-L2): an optional collector for swallowed crashes on the paths that end in the
    faceted fallback — a genuine outline crash, or `MakeFilling.Build` raising on EVERY rung of
    the interior ladder. Clean declines (a CLOSED region with no boundary loop, a holed region,
    a fill that builds but doesn't validate) collect nothing: they are the expected
    fundamental-limit paths, not errors. Fallback behavior is unchanged either way."""
    # SPEC-12 FR-10 / U10: when RECONSTRUCT_NURBS_URL is set, offload this region to the nurbs
    # service; its fitted face's rim interpolates the region polyline, so the caller's accuracy
    # gate + coincident-boundary sew handle it identically. Any failure (or unset env) ⇒ None ⇒
    # fall through to the existing MakeFilling path below, byte-for-byte unchanged.
    if nurbs_delegate._nurbs_url():
        delegated = nurbs_delegate.delegate_region_face(mesh, face_indices)
        if delegated is not None:
            return delegated
    try:
        outline = mesh.outline(face_indices)
        # A CLOSED region has no boundary edges (`entities` is empty; `.discrete` would raise on
        # it) — treat it as the clean no-loop decline below, so a raise HERE is a genuine crash.
        loops = outline.discrete if len(outline.entities) > 0 else []
    except Exception as e:  # noqa: BLE001 — degenerate region → not fillable as one patch; the
        # crash is logged AND surfaced via the collector (7-L2) so it is distinguishable from
        # the clean closed/holed declines, then the caller falls back to faceted (FR-8).
        logger.debug("region outline failed (%s: %s); falling back to faceted", type(e).__name__, e)
        if errors is not None:
            errors.append(f"region outline: {type(e).__name__}: {e}")
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
        return freeform_face(boundary, None, errors)
    # Try the richest (most accurate) interior set first, stepping down on a MakeFilling
    # failure (deterministic even strides). Returns the most accurate face that builds.
    # Rung crashes are collected LOCALLY: a rung raising while a poorer rung then succeeds is a
    # routine retry (not an error), so they only flush to `errors` when the whole ladder failed
    # — i.e. when the region really errored-and-fell-back (7-L2).
    ladder_errors: list[str] = []
    for k in _INTERIOR_LADDER:
        sub = interior if len(interior) <= k else interior[:: max(1, len(interior) // k)][:k]
        face = freeform_face(boundary, sub, ladder_errors)
        if face is not None:
            return face
    if errors is not None and ladder_errors:
        errors.extend(dict.fromkeys(ladder_errors))  # deduped, order-preserving
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
    # Full FR-7 chain (shared helper): real free-edge count, OrientClosedSolid (outward
    # orientation → positive volume), BRepCheck validity, volume > 0.
    solid, rep = verify_closure(BRepBuilderAPI_MakeSolid(topods.Shell(shape)).Solid(), orient=True)
    if not rep.is_solid:
        return None
    return SolidResult(solid, True, True, rep.free_edges, rep.volume, _faces_in(solid), primitive="freeform")


def face_max_point_error(face: TopoDS_Face, points: np.ndarray) -> float:
    """Max distance from `points` to the face's surface (fit-quality check)."""
    surf = BRep_Tool.Surface(face)
    worst = 0.0
    for p in np.asarray(points, dtype=float):
        proj = GeomAPI_ProjectPointOnSurf(gp_Pnt(float(p[0]), float(p[1]), float(p[2])), surf)
        if proj.NbPoints() > 0:
            worst = max(worst, float(proj.LowerDistance()))
    return worst
