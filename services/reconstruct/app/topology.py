"""SPEC-7 FR-6 / R6.9 — surface–surface intersection edge recovery + a cut-cylinder route.

The deterministic paths shipped so far obtain shared edges *implicitly* (CSG booleans,
`MakeRevol`, coincident analytic/mesh-polyline boundaries). This module adds the explicit
FR-6 mechanism the spec calls "THE crux": compute the exact shared edge between two adjacent
analytic surfaces by **surface–surface intersection** (`GeomAPI_IntSS`).

It is exercised end-to-end by `reconstruct_cut_cylinder` and `reconstruct_cut_sphere`:

* **cut_cylinder** — a cylinder trimmed by one or more *non-perpendicular* or *axis-parallel*
  planes (obliquely-capped cylinder, D-profile shaft). These break the axial symmetry
  `reconstruct_revolution` requires and are not the box±cylinder shape `reconstruct_csg` handles.
* **cut_sphere** — a sphere trimmed by a plane (hemisphere / spherical cap). A partial sphere
  fails the single-primitive volume gate (full sphere would over-volume) and is not CSG/revolution.

For both routes the curved surface + each cutting plane are fitted deterministically;
`GeomAPI_IntSS` confirms each plane actually crosses the surface (so a spurious plane is
rejected); the solid is built by half-space cuts (the boolean engine computes the exact shared
edges — the elliptical / circular / straight junctions `GeomAPI_IntSS` predicts). Self-validated
by volume vs. the watertight mesh; the caller falls back to faceted on any mismatch (FR-8/NFR-1).

Honest scope: FR-6 applied to the cylinder-vs-plane and sphere-vs-plane families. The fully
general per-region analytic reconstruction (arbitrary fitted curved faces with ideal trimmed
rims / analytic-rim sagitta) remains future work; the `GeomAPI_IntSS` primitive is the reusable
foundation for it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import networkx as nx
import numpy as np
import trimesh
from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
from OCC.Core.Geom import Geom_CylindricalSurface, Geom_Plane, Geom_SphericalSurface, Geom_Surface
from OCC.Core.GeomAbs import GeomAbs_Circle, GeomAbs_Ellipse, GeomAbs_Line
from OCC.Core.GeomAdaptor import GeomAdaptor_Curve
from OCC.Core.GeomAPI import GeomAPI_IntSS
from OCC.Core.gp import gp_Ax2, gp_Ax3, gp_Dir, gp_Pnt
from OCC.Core.TopAbs import TopAbs_SOLID
from OCC.Core.TopExp import TopExp_Explorer

from .closure import verify_closure
from .curved_faces import SolidResult, classify_faces
from .detect import dominant_axis
from .primitives import CylinderFit, fit_cylinder, fit_sphere

_CURVE_KIND = {GeomAbs_Circle: "circle", GeomAbs_Ellipse: "ellipse", GeomAbs_Line: "line"}


@dataclass
class IntersectionEdge:
    """An analytic intersection curve between two surfaces (FR-6 shared-edge candidate)."""

    kind: str  # "circle" | "ellipse" | "line" | "other"
    curve: object  # Geom_Curve (handle)


def shared_edge_by_intersection(
    surf_a: Geom_Surface, surf_b: Geom_Surface, tol: float = 1e-7
) -> list[IntersectionEdge]:
    """FR-6: the exact shared edge(s) between two analytic surfaces via `GeomAPI_IntSS`.

    Returns one `IntersectionEdge` per intersection branch (e.g. a plane cutting a cylinder
    perpendicularly → one circle; obliquely → one ellipse; two planes → one line). An empty
    list means the surfaces do not intersect within `tol`.
    """
    ints = GeomAPI_IntSS(surf_a, surf_b, tol)
    if not ints.IsDone():
        return []
    out: list[IntersectionEdge] = []
    for i in range(1, ints.NbLines() + 1):
        curve = ints.Line(i)
        ctype = GeomAdaptor_Curve(curve).GetType()
        out.append(IntersectionEdge(kind=_CURVE_KIND.get(ctype, "other"), curve=curve))
    return out


def _cyl_surface(fit: CylinderFit) -> Geom_CylindricalSurface:
    center = np.asarray(fit.center, dtype=float)
    axis = np.asarray(fit.axis, dtype=float)
    return Geom_CylindricalSurface(gp_Ax3(gp_Pnt(*center), gp_Dir(*axis)), fit.radius)


def _plane_surface(point: np.ndarray, normal: np.ndarray) -> Geom_Plane:
    return Geom_Plane(gp_Pnt(*point), gp_Dir(*normal))


def _halfspace_box(point: np.ndarray, normal: np.ndarray, size: float):
    """A large box occupying the +normal side of the plane through `point` (its base face lies
    on the plane), used as a cut tool that removes material outside the plane."""
    nrm = normal / (np.linalg.norm(normal) or 1.0)
    tmp = np.array([1.0, 0.0, 0.0]) if abs(nrm[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    x = np.cross(nrm, tmp)
    x = x / (np.linalg.norm(x) or 1.0)
    y = np.cross(nrm, x)
    corner = point - (size / 2.0) * x - (size / 2.0) * y
    ax2 = gp_Ax2(gp_Pnt(*corner), gp_Dir(*nrm), gp_Dir(*x))
    return BRepPrimAPI_MakeBox(ax2, size, size, size).Shape()


def _is_solid(shape) -> bool:
    return TopExp_Explorer(shape, TopAbs_SOLID).More()


def reconstruct_cut_cylinder(
    vertices: np.ndarray, faces: np.ndarray, vol_tol: float = 0.03
) -> Optional[SolidResult]:
    """A cylinder trimmed by one or more planes (oblique cap / D-shaft / flat-capped) → a
    watertight analytic solid, using FR-6 surface intersection to confirm the plane∩cylinder
    shared edges. Returns None (→ caller falls back) when the mesh isn't this shape or the
    reconstructed volume doesn't match the mesh."""
    v = np.asarray(vertices, dtype=float)
    f = np.asarray(faces, dtype=np.int64)
    mesh = trimesh.Trimesh(vertices=v, faces=f, process=False)
    if not mesh.is_volume:  # need a watertight, consistently-wound mesh to volume-validate
        return None
    mesh_volume = float(mesh.volume)
    if mesh_volume <= 0:
        return None

    axis = dominant_axis(mesh.face_normals)
    diag = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0]))
    fn = np.asarray(mesh.face_normals, dtype=float)
    centroids = np.asarray(mesh.triangles_center, dtype=float)

    # Partition faces into PLANAR regions (caps + axis-parallel flats — the cutting planes)
    # and CURVED faces (the cylinder side). A planar region is a connected patch of
    # near-coplanar faces with a tiny normal spread; a curved strip's normal rotates, so even
    # a finely-tessellated side never registers as planar. This is tessellation-independent —
    # an angle-to-axis or radial test cannot tell a D-shaft's axis-parallel flat from the
    # curved wall (both are perpendicular to the axis and, locally, at the same radius).
    graph = nx.Graph()
    graph.add_nodes_from(range(len(f)))
    for a, b in mesh.face_adjacency:
        if float(fn[a] @ fn[b]) > 0.999:  # ~2.5°: only near-coplanar neighbours connect
            graph.add_edge(int(a), int(b))
    planar_mask = np.zeros(len(f), dtype=bool)
    planes: list[tuple[np.ndarray, np.ndarray]] = []
    for comp in nx.connected_components(graph):
        idx = np.fromiter(comp, dtype=np.int64)
        if idx.size < 3:
            continue  # a cylinder facet is exactly 2 coplanar triangles (one quad); a real
            # planar region (a cap, an oblique cap) is a fan of ≥3. <3 ⇒ treat as curved side.
        ns = fn[idx]
        mean = ns.mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if norm < 1e-9:
            continue
        mean = mean / norm
        # A true planar patch has ~zero normal spread; a chained curved strip spans the
        # section angle (≫0.8°) → rejected. (Tessellation-independent flat vs. curve test.)
        if float((ns @ mean).min()) < 0.9999:
            continue
        planar_mask[idx] = True
        planes.append((mean, centroids[idx].mean(axis=0)))
    if not planes or len(planes) > 8:
        return None

    side = ~planar_mask
    if side.sum() < 4:
        return None
    side_vertices = mesh.vertices[np.unique(mesh.faces[side])]
    fit = fit_cylinder(side_vertices, fn[side])
    if fit.radius <= 0 or fit.rms > 0.02 * diag:  # the non-planar faces aren't a clean cylinder
        return None

    # Build a cylinder long enough to span the whole part, then cut each plane's half-space.
    # The axis line passes through fit.center; place the base at absolute axial coord
    # (proj.min()-margin) by sliding along the axis from fit.center (whose own axial
    # coordinate must be subtracted — fit.center is mid-axis, not at the base).
    center = np.asarray(fit.center, dtype=float)
    proj = mesh.vertices @ axis
    margin = 0.1 * (proj.max() - proj.min()) + 1e-6
    center_proj = float(center @ axis)
    base_center = center + axis * ((proj.min() - margin) - center_proj)
    height = (proj.max() - proj.min()) + 2 * margin
    cyl_surf = _cyl_surface(fit)
    solid = BRepPrimAPI_MakeCylinder(
        gp_Ax2(gp_Pnt(*base_center), gp_Dir(*axis)), fit.radius, height
    ).Solid()

    used_planes = 0
    for normal, point in planes:
        # FR-6: only keep a plane that actually crosses the cylinder (real shared edge).
        if not shared_edge_by_intersection(cyl_surf, _plane_surface(point, normal)):
            continue
        tool = _halfspace_box(point, normal, 4.0 * diag + 1e-3)
        cut = BRepAlgoAPI_Cut(solid, tool)
        cut.Build()
        if not cut.IsDone():
            return None
        solid = cut.Shape()
        used_planes += 1

    if used_planes == 0 or not _is_solid(solid):
        return None
    # FR-7 (shared closure helper): validity + COMPUTED free-edge count + positive volume —
    # never hardcoded. Boolean-cut results are born outward-oriented, so no re-orientation is
    # needed (same orient semantics as the csg / revolution routes).
    solid, rep = verify_closure(solid)
    if not rep.is_solid or abs(rep.volume - mesh_volume) / mesh_volume > vol_tol:
        return None

    planar, curved, _freeform = classify_faces(solid)
    n_faces = planar + curved + _freeform
    return SolidResult(solid, True, True, rep.free_edges, rep.volume, n_faces, primitive="cut_cylinder")


def reconstruct_cut_sphere(
    vertices: np.ndarray, faces: np.ndarray, vol_tol: float = 0.04
) -> Optional[SolidResult]:
    """Sphere (or spherical region) trimmed by a plane → analytic solid (T37 / FR-6 family).

    Uses `GeomAPI_IntSS` (sphere ∩ plane = circle) to confirm a real shared edge, then
    boolean half-space cuts. Returns None when the mesh is not a clean sphere+plane cut
    or the volume gate fails (→ faceted/fitted fallback).

    Sphere parameters are fit only on the *curved* faces: planar-cap interior vertices do not
    lie on the sphere and would bias a whole-mesh fit (a hemisphere's disc is full of in-plane
    points). Half-space orientation is chosen by volume match so either cap-normal sign works.
    """
    v = np.asarray(vertices, dtype=float)
    f = np.asarray(faces, dtype=np.int64)
    mesh = trimesh.Trimesh(vertices=v, faces=f, process=False)
    if not mesh.is_volume:
        return None
    mesh_volume = float(mesh.volume)
    if mesh_volume <= 0:
        return None

    # Find planar cap region(s) first (same coplanar-component logic as cut_cylinder).
    fn = np.asarray(mesh.face_normals, dtype=float)
    centroids = np.asarray(mesh.triangles_center, dtype=float)
    graph = nx.Graph()
    graph.add_nodes_from(range(len(f)))
    for a, b in mesh.face_adjacency:
        if float(fn[a] @ fn[b]) > 0.999:
            graph.add_edge(int(a), int(b))
    planar_mask = np.zeros(len(f), dtype=bool)
    planes: list[tuple[np.ndarray, np.ndarray]] = []
    for comp in nx.connected_components(graph):
        idx = np.fromiter(comp, dtype=np.int64)
        if idx.size < 3:
            continue
        ns = fn[idx]
        mean = ns.mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if norm < 1e-9:
            continue
        mean = mean / norm
        if float((ns @ mean).min()) < 0.9999:
            continue
        planar_mask[idx] = True
        planes.append((mean, centroids[idx].mean(axis=0)))
    if not planes or len(planes) > 4:
        return None

    # Algebraic sphere fit on curved-face vertices only (planar cap interiors are off-sphere).
    side = ~planar_mask
    if side.sum() < 8:
        return None
    side_vertices = mesh.vertices[np.unique(mesh.faces[side])]
    try:
        fit = fit_sphere(side_vertices)
    except ValueError:
        return None
    diag = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0]))
    if fit.radius <= 0 or fit.rms > 0.02 * max(fit.radius, 1e-9):
        return None
    # Partial spheres must under-volume a full sphere; reject full spheres (single_primitive owns them).
    full_vol = (4.0 / 3.0) * np.pi * fit.radius**3
    if mesh_volume > 0.92 * full_vol:
        return None

    center = np.asarray(fit.center, dtype=float)
    radius = float(fit.radius)
    sph_surf = Geom_SphericalSurface(gp_Ax3(gp_Pnt(*center), gp_Dir(0, 0, 1)), radius)

    # Try both half-space signs per plane; keep the orientation that volume-matches the mesh.
    # (Face-normal direction of a tessellated cap is not a reliable "material side" signal.)
    solid = BRepPrimAPI_MakeSphere(gp_Pnt(*center), radius).Solid()
    used = 0
    for normal, point in planes:
        if not shared_edge_by_intersection(sph_surf, _plane_surface(point, normal)):
            continue
        best_shape = None
        best_err = float("inf")
        for sign in (1.0, -1.0):
            tool = _halfspace_box(point, sign * normal, 4.0 * diag + 1e-3)
            cut = BRepAlgoAPI_Cut(solid, tool)
            cut.Build()
            if not cut.IsDone() or not _is_solid(cut.Shape()):
                continue
            trial, rep = verify_closure(cut.Shape())
            if not rep.is_solid or rep.volume <= 0:
                continue
            err = abs(rep.volume - mesh_volume) / mesh_volume
            if err < best_err:
                best_err = err
                best_shape = trial
        if best_shape is None:
            return None
        solid = best_shape
        used += 1

    if used == 0 or not _is_solid(solid):
        return None
    solid, rep = verify_closure(solid)
    if not rep.is_solid or abs(rep.volume - mesh_volume) / mesh_volume > vol_tol:
        return None
    planar, curved, _freeform = classify_faces(solid)
    n_faces = planar + curved + _freeform
    return SolidResult(solid, True, True, rep.free_edges, rep.volume, n_faces, primitive="cut_sphere")
