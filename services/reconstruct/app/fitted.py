"""Analytic-face reconstruction (R6.4 + R6.5).

Collapses each planar facet (R6.3) into ONE trimmed OCCT planar face built from the
facet's boundary loop, instead of one face per triangle — a clean, compact B-rep for the
flat regions of a part. The remaining (non-planar) triangles are grouped into connected
CURVED regions; each region with a single boundary loop is collapsed into ONE freeform
face (R6.5 — `BRepOffsetAPI_MakeFilling`), so a smooth patch bounded by flats becomes one
surface instead of many triangles. Facets/regions that have holes (multiple loops), fail to
build, or whose freeform fit is too coarse fall back to per-triangle faces (R6.1) so nothing
is dropped. All faces are sewn into a shell and a solid when watertight.

Freeform faces are APPROXIMATIONS (unlike the exact planar collapse), so they are guarded
twice: a per-region accuracy gate (the fitted surface must stay within a fraction of the
mesh size of the region's vertices) and, after assembly, a volume check against the mesh —
if the freeform-enhanced solid drifts, the whole part is rebuilt faceted-only. Closed
regions with no boundary loop (e.g. a whole organic blob) can't be one filled patch and stay
faceted — a fundamental limit of single-patch filling, not a fallback bug.
"""

from __future__ import annotations

from dataclasses import dataclass

import networkx as nx
import numpy as np
import trimesh
from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
)
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepGProp import brepgprop
from OCC.Core.gp import gp_Pnt
from OCC.Core.GProp import GProp_GProps
from OCC.Core.TopAbs import TopAbs_SHELL, TopAbs_SOLID
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Face, TopoDS_Shape, topods

from .freeform import face_max_point_error, freeform_region_face
from .segment import planar_segments


@dataclass
class FittedResult:
    shape: TopoDS_Shape
    triangles_in: int
    planar_faces: int
    triangle_faces: int
    is_solid: bool
    is_valid: bool
    freeform_faces: int = 0


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


def _curved_components(mesh: trimesh.Trimesh, leftover: np.ndarray) -> list[np.ndarray]:
    """Connected components of the non-planar (leftover) triangles — each a curved region."""
    lset = {int(i) for i in leftover}
    g = nx.Graph()
    g.add_nodes_from(lset)
    for a, b in mesh.face_adjacency:
        if int(a) in lset and int(b) in lset:
            g.add_edge(int(a), int(b))
    return [np.array(sorted(c), dtype=np.int64) for c in nx.connected_components(g)]


def _solid_volume(shape: TopoDS_Shape) -> float:
    props = GProp_GProps()
    brepgprop.VolumeProperties(shape, props)
    return abs(float(props.Mass()))


def _assemble(
    mesh: trimesh.Trimesh,
    facets: list[np.ndarray],
    leftover: np.ndarray,
    sew_tol: float,
    use_freeform: bool,
    accuracy_tol: float,
) -> FittedResult:
    """Sew planar facet faces + (freeform | faceted) curved regions + leftover triangles into
    a shell/solid. `accuracy_tol` is the max allowed freeform surface error (absolute, metres);
    a region whose freeform fit exceeds it (or isn't single-loop) is kept faceted."""
    verts = np.asarray(mesh.vertices, dtype=float)
    sewing = BRepBuilderAPI_Sewing(sew_tol)
    planar = 0
    tri_faces = 0
    freeform = 0

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

    if use_freeform:
        for comp in _curved_components(mesh, leftover):
            ff = freeform_region_face(mesh, comp) if len(comp) >= 2 else None
            region_v = mesh.vertices[np.unique(mesh.faces[comp])]
            if ff is not None and face_max_point_error(ff, region_v) <= accuracy_tol:
                sewing.Add(ff)
                freeform += 1
            else:
                _add_triangles(comp)  # not single-loop / too coarse → keep triangles
    else:
        _add_triangles(leftover)  # faceted curved regions

    if planar + tri_faces + freeform == 0:
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
            return FittedResult(solid, len(mesh.faces), planar, tri_faces, True, True, freeform)

    return FittedResult(sewn, len(mesh.faces), planar, tri_faces, False, BRepCheck_Analyzer(sewn).IsValid(), freeform)


def fitted_shape(
    vertices: np.ndarray,
    faces: np.ndarray,
    sew_tol: float = 1e-6,
    *,
    freeform: bool = True,
    vol_tol: float = 0.05,
) -> FittedResult:
    """Reconstruct planar facets into single trimmed faces + curved single-loop regions into
    freeform faces (faceted fallback otherwise). Freeform is guarded by a per-region accuracy
    gate and a post-assembly volume check (rebuilds faceted-only if it breaks closure/volume)."""
    mesh, facets, leftover = planar_segments(vertices, faces)
    # Accuracy gate scales with the part: 1% of the mesh bounding-box diagonal.
    diag = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0])) if mesh.bounds is not None else 0.0
    accuracy_tol = max(diag * 0.01, 1e-6)

    result = _assemble(mesh, facets, leftover, sew_tol, freeform, accuracy_tol)
    if not freeform or result.freeform_faces == 0:
        return result

    # Freeform faces approximate the mesh — verify the enhanced solid didn't break closure or
    # drift in volume; if it did, rebuild faceted-only (exact, always valid) so freeform never
    # degrades the result.
    mesh_vol = abs(float(mesh.volume)) if mesh.is_watertight else 0.0
    drifted = result.is_solid and mesh_vol > 0 and abs(_solid_volume(result.shape) - mesh_vol) / mesh_vol > vol_tol
    if not result.is_solid or drifted:
        faceted = _assemble(mesh, facets, leftover, sew_tol, False, accuracy_tol)
        # Prefer the faceted rebuild only when it is at least as good (a real solid).
        if faceted.is_solid or not result.is_solid:
            return faceted
    return result
