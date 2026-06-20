"""R6.4a — deterministic cylinder fit + analytic solid (the curved-reconstruction gate).

Proves: (1) the fit recovers radius/axis/height exactly and deterministically; (2) the
cylinder builds as a watertight 3-face analytic SOLID; (3) the shared-edge crux — analytic
caps sew to a solid but faceted (polygon) caps regress to a shell (SPEC-7 §D-3)."""

from math import pi

import numpy as np
import pytest
import trimesh
from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
)
from OCC.Core.gp import gp_Ax3, gp_Cylinder, gp_Dir, gp_Pln, gp_Pnt
from OCC.Core.TopAbs import TopAbs_SHELL
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import topods

from app.curved_faces import cylinder_solid
from app.detect import reconstruct_cylinder
from app.primitives import fit_cylinder

R_TRUE, H_TRUE = 0.011, 0.027


def _cylinder_region(sections: int) -> tuple[np.ndarray, np.ndarray, trimesh.Trimesh]:
    m = trimesh.creation.cylinder(radius=R_TRUE, height=H_TRUE, sections=sections)
    side = np.abs(m.face_normals @ np.array([0, 0, 1.0])) < 0.3
    verts = m.vertices[np.unique(m.faces[side])]
    return verts, m.face_normals[side], m


@pytest.mark.parametrize("sections", [16, 32, 64])
def test_fit_recovers_radius_axis_height(sections: int):
    verts, fn, _ = _cylinder_region(sections)
    fit = fit_cylinder(verts, fn)
    assert abs(fit.radius - R_TRUE) < 2e-4
    assert abs(abs(float(fit.axis @ np.array([0, 0, 1.0]))) - 1.0) < 1e-3
    assert abs(fit.height - H_TRUE) < 5e-4
    assert fit.rms < 1e-4  # vertices lie on the fitted cylinder


def test_fit_is_deterministic():
    verts, fn, _ = _cylinder_region(32)
    a = fit_cylinder(verts, fn)
    b = fit_cylinder(verts, fn)
    assert a.radius == b.radius
    assert np.array_equal(a.axis, b.axis)
    assert (a.vmin, a.vmax) == (b.vmin, b.vmax)


def test_cylinder_solid_is_watertight_three_faces():
    verts, fn, _ = _cylinder_region(48)
    res = cylinder_solid(fit_cylinder(verts, fn))
    assert res.is_solid
    assert res.is_valid
    assert res.free_edges == 0
    assert res.n_faces == 3  # lateral + 2 caps, not dozens of triangles
    assert abs(res.volume - pi * R_TRUE**2 * H_TRUE) < 1e-8


def test_end_to_end_reconstruct_cylinder_mesh():
    m = trimesh.creation.cylinder(radius=R_TRUE, height=H_TRUE, sections=48)
    res = reconstruct_cylinder(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res.is_solid
    assert abs(res.volume - pi * R_TRUE**2 * H_TRUE) < 1e-7


def test_faceted_caps_regress_to_shell_not_solid():
    """The crux (SPEC-7 §D-3): an analytic cylinder + POLYGON caps cannot sew to a solid,
    because the polygon rim deviates from the cylinder's smooth rim by the sagitta."""
    cyl = gp_Cylinder(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), R_TRUE)
    lateral = BRepBuilderAPI_MakeFace(cyl, 0.0, 2 * pi, 0.0, H_TRUE).Face()

    def polygon_cap(z: float, nz: float, n: int = 24):
        poly = BRepBuilderAPI_MakePolygon()
        for i in range(n):
            a = 2 * pi * i / n
            poly.Add(gp_Pnt(R_TRUE * np.cos(a), R_TRUE * np.sin(a), z))
        poly.Close()
        return BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, z), gp_Dir(0, 0, nz)), poly.Wire(), True).Face()

    sew = BRepBuilderAPI_Sewing(1e-6)
    for f in (lateral, polygon_cap(0.0, -1.0), polygon_cap(H_TRUE, 1.0)):
        sew.Add(f)
    sew.Perform()
    assert sew.NbFreeEdges() > 0  # polygon rim ≠ smooth rim → free edges
    maker = BRepBuilderAPI_MakeSolid()
    exp = TopExp_Explorer(sew.SewedShape(), TopAbs_SHELL)
    shells = 0
    while exp.More():
        maker.Add(topods.Shell(exp.Current()))
        shells += 1
        exp.Next()
    assert shells == 0  # no closed shell → not a solid (regression the analytic path avoids)
