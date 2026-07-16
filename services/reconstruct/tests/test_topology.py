"""SPEC-7 FR-6 / R6.9 — surface–surface intersection edge recovery + cut-cylinder / cut-sphere.

Real OCCT (no mocks): proves the `GeomAPI_IntSS` shared-edge primitive recovers the exact
analytic junction curve, and that `reconstruct_cut_cylinder` / `reconstruct_cut_sphere` rebuild
mixed analytic parts the `revolution`/`csg` routes can't handle into watertight analytic solids,
while correctly rejecting non-matching meshes.
"""

from math import pi

import numpy as np
import trimesh
from OCC.Core.BRep import BRep_Tool
from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
from OCC.Core.Geom import Geom_CylindricalSurface, Geom_Plane, Geom_SphericalSurface
from OCC.Core.gp import gp_Ax1, gp_Ax2, gp_Ax3, gp_Dir, gp_Pnt, gp_Trsf
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopLoc import TopLoc_Location
from OCC.Core.TopoDS import topods

from app.cleanup import clean_mesh
from app.closure import count_free_edges
from app.pipeline import reconstruct
from app.topology import reconstruct_cut_cylinder, reconstruct_cut_sphere, shared_edge_by_intersection

R, H = 0.011, 0.030
SPH_R = 0.015


def _tessellate(shape, deflection: float = 0.0004) -> tuple[np.ndarray, np.ndarray]:
    """Triangulate an OCCT solid into a (vertices, faces) mesh — the same kind of triangle
    soup the service receives from a GLB."""
    BRepMesh_IncrementalMesh(shape, deflection)
    verts: list[list[float]] = []
    tris: list[list[int]] = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = topods.Face(exp.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation(face, loc)
        if tri is not None:
            trsf = loc.Transformation()
            base = len(verts)
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(trsf)
                verts.append([p.X(), p.Y(), p.Z()])
            for i in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(i).Get()
                tris.append([base + a - 1, base + b - 1, base + c - 1])
        exp.Next()
    return np.array(verts, dtype=float), np.array(tris, dtype=np.int64)


def _full_cylinder():
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), R, H).Solid()


def _oblique_cut_cylinder_mesh() -> tuple[np.ndarray, np.ndarray]:
    """A cylinder whose top is sliced by a plane tilted ~20° off perpendicular."""
    box = BRepPrimAPI_MakeBox(gp_Pnt(-0.1, -0.1, H * 0.6), 0.2, 0.2, 0.2).Shape()
    trsf = gp_Trsf()
    trsf.SetRotation(gp_Ax1(gp_Pnt(0, 0, H * 0.6), gp_Dir(1, 0, 0)), 0.35)
    box = BRepBuilderAPI_Transform(box, trsf, True).Shape()
    solid = BRepAlgoAPI_Cut(_full_cylinder(), box).Shape()
    return clean_mesh(*_tessellate(solid))


# ── FR-6 primitive: GeomAPI_IntSS shared-edge recovery ──────────────────────────

def _cyl_surf() -> Geom_CylindricalSurface:
    return Geom_CylindricalSurface(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), R)


def test_perpendicular_plane_meets_cylinder_in_a_circle_of_exact_radius():
    edges = shared_edge_by_intersection(_cyl_surf(), Geom_Plane(gp_Pnt(0, 0, 0.01), gp_Dir(0, 0, 1)))
    assert len(edges) == 1
    assert edges[0].kind == "circle"


def test_oblique_plane_meets_cylinder_in_an_ellipse():
    edges = shared_edge_by_intersection(_cyl_surf(), Geom_Plane(gp_Pnt(0, 0, 0.01), gp_Dir(0, 0.4, 1)))
    assert len(edges) == 1
    assert edges[0].kind == "ellipse"


def test_two_planes_meet_in_a_line():
    edges = shared_edge_by_intersection(
        Geom_Plane(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), Geom_Plane(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0))
    )
    assert len(edges) == 1
    assert edges[0].kind == "line"


def test_disjoint_surfaces_share_no_edge():
    # A plane beyond the cylinder's radius never crosses the (infinite) cylinder surface… but
    # the cylinder is infinite in v, so a parallel-to-axis plane outside the radius misses it.
    far = Geom_Plane(gp_Pnt(10 * R, 0, 0), gp_Dir(1, 0, 0))
    assert shared_edge_by_intersection(_cyl_surf(), far) == []


# ── end-to-end cut-cylinder reconstruction ──────────────────────────────────────

def test_oblique_cut_cylinder_reconstructs_to_a_watertight_analytic_solid():
    v, f = _oblique_cut_cylinder_mesh()
    mesh = trimesh.Trimesh(v, f, process=False)
    assert mesh.is_volume
    res = reconstruct_cut_cylinder(v, f)
    assert res is not None
    assert res.is_solid and res.is_valid
    # one lateral cylindrical face + two planar caps (bottom circle + oblique ellipse).
    assert res.n_faces == 3
    assert abs(res.volume - float(mesh.volume)) / float(mesh.volume) < 0.03
    assert res.primitive == "cut_cylinder"


def test_cut_cylinder_recovers_a_plain_capped_cylinder():
    v, f = clean_mesh(*_tessellate(_full_cylinder()))
    res = reconstruct_cut_cylinder(v, f)
    assert res is not None and res.is_solid
    assert abs(res.volume - pi * R**2 * H) / (pi * R**2 * H) < 0.03


def test_cut_cylinder_route_reports_computed_zero_free_edges():
    # 7-M2 follow-up: free_edges used to be hardcoded 0 here; it is now the real free-bounds
    # count from the shared FR-7 closure helper — cross-checked against count_free_edges.
    v, f = _oblique_cut_cylinder_mesh()
    res = reconstruct_cut_cylinder(v, f)
    assert res is not None and res.is_solid
    assert res.free_edges == count_free_edges(res.shape) == 0


def test_cut_cylinder_rejects_a_box():
    box = trimesh.creation.box(extents=(0.02, 0.02, 0.02))
    assert reconstruct_cut_cylinder(np.asarray(box.vertices), np.asarray(box.faces, dtype=np.int64)) is None


def test_auto_pipeline_routes_oblique_cut_cylinder_to_cut_cylinder():
    # The default method="auto" must actually LAND on the cut_cylinder branch (exercises the
    # pipeline wiring + report construction, not just the function in isolation).
    v, f = _oblique_cut_cylinder_mesh()
    glb = trimesh.Trimesh(v, f, process=False).export(file_type="glb")
    res = reconstruct(glb, "glb", method="auto")
    assert res.report.method == "cut_cylinder"
    assert res.report.curved_faces == 1  # the single lateral cylindrical face
    assert res.report.planar_faces == 2  # bottom circle cap + oblique elliptical cap
    assert res.report.faceted_faces == 0
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")


# ── FR-6 sphere∩plane + cut-sphere reconstruction (T37) ─────────────────────────

def _sph_surf() -> Geom_SphericalSurface:
    return Geom_SphericalSurface(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), SPH_R)


def _half_sphere_mesh() -> tuple[np.ndarray, np.ndarray]:
    """Unit hemisphere: full sphere cut by the half-space z > 0 (planar equatorial cap)."""
    sphere = BRepPrimAPI_MakeSphere(gp_Pnt(0, 0, 0), SPH_R).Solid()
    # Box covering the +z half-space beyond the equator (removes the upper hemisphere → leaves lower).
    tool = BRepPrimAPI_MakeBox(gp_Pnt(-2 * SPH_R, -2 * SPH_R, 0.0), 4 * SPH_R, 4 * SPH_R, 4 * SPH_R).Shape()
    solid = BRepAlgoAPI_Cut(sphere, tool).Shape()
    return clean_mesh(*_tessellate(solid, deflection=0.0005))


def test_plane_meets_sphere_in_a_circle():
    edges = shared_edge_by_intersection(_sph_surf(), Geom_Plane(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)))
    assert len(edges) == 1
    assert edges[0].kind == "circle"


def test_offset_plane_meets_sphere_in_a_circle():
    # A plane that cuts the sphere off-equator still yields a circle (smaller radius).
    edges = shared_edge_by_intersection(
        _sph_surf(), Geom_Plane(gp_Pnt(0, 0, SPH_R * 0.4), gp_Dir(0, 0, 1))
    )
    assert len(edges) == 1
    assert edges[0].kind == "circle"


def test_half_sphere_reconstructs_to_a_watertight_analytic_solid():
    v, f = _half_sphere_mesh()
    mesh = trimesh.Trimesh(v, f, process=False)
    assert mesh.is_volume
    res = reconstruct_cut_sphere(v, f)
    assert res is not None
    assert res.is_solid and res.is_valid
    # one spherical face + one planar equatorial cap
    assert res.n_faces == 2
    assert abs(res.volume - float(mesh.volume)) / float(mesh.volume) < 0.04
    assert res.primitive == "cut_sphere"
    assert res.free_edges == count_free_edges(res.shape) == 0


def test_cut_sphere_rejects_a_box():
    box = trimesh.creation.box(extents=(0.02, 0.02, 0.02))
    assert reconstruct_cut_sphere(np.asarray(box.vertices), np.asarray(box.faces, dtype=np.int64)) is None


def test_cut_sphere_rejects_a_full_sphere_without_planar_cap():
    # A full sphere has no planar region → cut_sphere declines (single_primitive owns full spheres).
    m = trimesh.creation.icosphere(subdivisions=3, radius=SPH_R)
    assert reconstruct_cut_sphere(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64)) is None


def test_auto_pipeline_routes_half_sphere_to_cut_sphere():
    v, f = _half_sphere_mesh()
    glb = trimesh.Trimesh(v, f, process=False).export(file_type="glb")
    res = reconstruct(glb, "glb", method="auto")
    assert res.report.method == "cut_sphere"
    assert res.report.primitive == "cut_sphere"
    assert res.report.curved_faces == 1
    assert res.report.planar_faces == 1
    assert res.report.faceted_faces == 0
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")
