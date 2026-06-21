"""Build trimmed analytic OCCT faces + solids from primitive fits (SPEC-7 R6.4).

A fitted cylinder becomes THREE analytic faces — one lateral `Geom_CylindricalSurface` face
(natural UV bounds: full 2π × the axial extent) and two planar circle caps — whose rim
boundaries are the SAME exact analytic circle. Because the caps' boundary and the lateral
face's natural rim are the identical analytic circle (zero deviation), sewing merges them
into shared edges → a watertight solid. This is the shared-edge principle (SPEC-7 §D-3):
analytic-to-analytic boundaries coincide and sew; a faceted polygon cap would deviate by the
sagitta and leave free edges (a shell). Closure is verified, never assumed.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import pi
from typing import Optional

import numpy as np
from OCC.Core.BRepAdaptor import BRepAdaptor_Surface
from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_MakeWire,
    BRepBuilderAPI_Sewing,
)
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.GeomAbs import (
    GeomAbs_BezierSurface,
    GeomAbs_BSplineSurface,
    GeomAbs_Plane,
)
from OCC.Core.BRepGProp import brepgprop
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeCone, BRepPrimAPI_MakeSphere
from OCC.Core.gp import gp_Ax2, gp_Ax3, gp_Circ, gp_Cylinder, gp_Dir, gp_Pln, gp_Pnt
from OCC.Core.GProp import GProp_GProps
from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_SHELL
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Shape, topods

from .primitives import ConeFit, CylinderFit, SphereFit


@dataclass
class SolidResult:
    shape: TopoDS_Shape
    is_solid: bool
    is_valid: bool
    free_edges: int
    volume: float
    n_faces: int
    primitive: Optional[str] = None  # "cylinder" | "sphere" | "cone" when known


def classify_faces(shape: TopoDS_Shape) -> tuple[int, int, int]:
    """Count (planar, curved, freeform) faces of a built shape by their OCCT surface type.

    planar   = `Geom_Plane` (analytic flat faces, e.g. a cylinder cap or a box side).
    curved   = analytic non-planar (cylinder / cone / sphere / torus / surface-of-revolution
               / surface-of-extrusion) — everything that isn't a plane or a free-form patch.
    freeform = BSpline / Bezier patches (the R6.5 `MakeFilling` output).

    NOTE: a per-triangle FACETED face is also a `Geom_Plane`, so this helper is meaningful
    only for the analytic methods (primitive / revolution / csg) which contain no faceted
    faces. The `fitted`/`faceted` methods report their own faceted counts (they know which
    faces they emitted as fallback) and do not use this helper for `planar`/`curved`.
    """
    planar = curved = freeform = 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        surf_type = BRepAdaptor_Surface(topods.Face(exp.Current())).GetType()
        if surf_type == GeomAbs_Plane:
            planar += 1
        elif surf_type in (GeomAbs_BSplineSurface, GeomAbs_BezierSurface):
            freeform += 1
        else:
            curved += 1
        exp.Next()
    return planar, curved, freeform


def _circle_cap(center: np.ndarray, axis: np.ndarray, v: float, radius: float, outward: float):
    """A planar disk face bounded by the exact circle radius `radius` at axial position `v`,
    its plane normal pointing `outward` (±1) along the axis."""
    p = gp_Pnt(*(center + axis * v))
    nd = gp_Dir(*(axis * outward))
    edge = BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(p, nd), radius)).Edge()
    wire = BRepBuilderAPI_MakeWire(edge).Wire()
    return BRepBuilderAPI_MakeFace(gp_Pln(p, nd), wire, True).Face()


def cylinder_solid(fit: CylinderFit, sew_tol: float = 1e-6) -> SolidResult:
    """Build a watertight B-rep solid from a cylinder fit: lateral analytic face + two
    analytic circle caps sharing the exact rim circles. Verifies closure."""
    center = np.asarray(fit.center, dtype=float)
    axis = np.asarray(fit.axis, dtype=float)
    cyl = gp_Cylinder(gp_Ax3(gp_Pnt(*center), gp_Dir(*axis)), fit.radius)
    lateral = BRepBuilderAPI_MakeFace(cyl, 0.0, 2 * pi, fit.vmin, fit.vmax).Face()
    bottom = _circle_cap(center, axis, fit.vmin, fit.radius, -1.0)
    top = _circle_cap(center, axis, fit.vmax, fit.radius, +1.0)

    sewing = BRepBuilderAPI_Sewing(sew_tol)
    for f in (lateral, bottom, top):
        sewing.Add(f)
    sewing.Perform()
    sewn = sewing.SewedShape()
    free = sewing.NbFreeEdges()

    maker = BRepBuilderAPI_MakeSolid()
    shells = 0
    exp = TopExp_Explorer(sewn, TopAbs_SHELL)
    while exp.More():
        maker.Add(topods.Shell(exp.Current()))
        shells += 1
        exp.Next()

    if shells == 0 or not maker.IsDone():
        return SolidResult(sewn, False, BRepCheck_Analyzer(sewn).IsValid(), free, 0.0, 3)

    solid = maker.Solid()
    valid = BRepCheck_Analyzer(solid).IsValid()
    props = GProp_GProps()
    brepgprop.VolumeProperties(solid, props)
    volume = float(props.Mass())
    # MakeSolid does NOT validate closure — require valid + no free edges + positive volume.
    is_solid = bool(valid and free == 0 and volume > 0)
    return SolidResult(solid if is_solid else sewn, is_solid, valid, free, volume, 3)


def _solid_report(solid: TopoDS_Shape) -> SolidResult:
    """Validate + measure a BRepPrimAPI solid (sphere/cone) — no sewing needed (these are
    born closed). Closure is still verified, never assumed."""
    valid = BRepCheck_Analyzer(solid).IsValid()
    props = GProp_GProps()
    brepgprop.VolumeProperties(solid, props)
    volume = float(props.Mass())
    n_faces = 0
    exp = TopExp_Explorer(solid, TopAbs_FACE)
    while exp.More():
        n_faces += 1
        exp.Next()
    is_solid = bool(valid and volume > 0)
    return SolidResult(solid, is_solid, valid, 0, volume, n_faces)


def sphere_solid(fit: SphereFit) -> SolidResult:
    """A watertight analytic sphere solid from a sphere fit (BRepPrimAPI handles the seam +
    poles correctly — a hand-sewn natural-bounds sphere face does not solidify)."""
    center = np.asarray(fit.center, dtype=float)
    solid = BRepPrimAPI_MakeSphere(gp_Ax2(gp_Pnt(*center), gp_Dir(0, 0, 1)), fit.radius).Solid()
    return _solid_report(solid)


def cone_solid(fit: ConeFit) -> SolidResult:
    """A watertight analytic cone solid from a cone fit: BRepPrimAPI cone with the base at
    `base_center`, the axis pointing base→apex, top radius 0 (a pointed cone)."""
    base = np.asarray(fit.base_center, dtype=float)
    axis = np.asarray(fit.axis, dtype=float)  # base → apex
    solid = BRepPrimAPI_MakeCone(
        gp_Ax2(gp_Pnt(*base), gp_Dir(*axis)), fit.base_radius, 0.0, fit.height
    ).Solid()
    return _solid_report(solid)
