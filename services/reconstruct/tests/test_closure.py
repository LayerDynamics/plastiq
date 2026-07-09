"""FR-7 closure verification: `free_edges` is COMPUTED (free-bounds analysis), never
hardcoded, and `is_solid` requires validity + zero free edges + positive volume on every
reconstruction path. A deliberately open shell must report free_edges > 0 / is_solid False."""

import numpy as np
import trimesh
from OCC.Core.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCone,
    BRepPrimAPI_MakeSphere,
)

from app.closure import count_free_edges, verify_closure
from app.detect import reconstruct_cone, reconstruct_sphere
from app.faceted import faceted_shape
from app.fitted import fitted_shape
from app.revolution import reconstruct_revolution


def _open_box_arrays() -> tuple[np.ndarray, np.ndarray]:
    """A box mesh with one triangle removed — a deliberately open shell (3 naked edges)."""
    box = trimesh.creation.box(extents=(0.02, 0.02, 0.02))
    return np.asarray(box.vertices, dtype=float), np.asarray(box.faces, dtype=np.int64)[:-1]


def test_count_free_edges_ignores_seam_and_degenerated_edges():
    # Closed analytic solids have seam (cylinder/sphere) and degenerated (pole/apex) edges;
    # the free-bounds analysis must not miscount them as naked.
    assert count_free_edges(BRepPrimAPI_MakeSphere(0.01).Solid()) == 0
    assert count_free_edges(BRepPrimAPI_MakeCone(0.01, 0.0, 0.02).Solid()) == 0


def test_verify_closure_accepts_a_closed_solid():
    solid = BRepPrimAPI_MakeBox(0.02, 0.02, 0.02).Solid()
    _, rep = verify_closure(solid)
    assert rep.is_solid and rep.is_valid
    assert rep.free_edges == 0
    assert abs(rep.volume - 0.02**3) < 1e-12


def test_verify_closure_orients_an_inward_solid_outward():
    # A reversed (inward-oriented) closed solid encloses negative volume; orient=True must
    # flip it outward so a mere winding artefact is not misreported as "no volume".
    reversed_solid = BRepPrimAPI_MakeBox(0.02, 0.02, 0.02).Solid().Reversed()
    _, rep_raw = verify_closure(reversed_solid)
    assert rep_raw.volume < 0 and not rep_raw.is_solid
    _, rep = verify_closure(reversed_solid, orient=True)
    assert rep.is_solid and rep.volume > 0


def test_faceted_open_shell_reports_free_edges_and_not_solid():
    v, f = _open_box_arrays()
    res = faceted_shape(v, f)
    assert not res.is_solid
    assert res.free_edges == 3  # the dropped triangle's boundary
    assert count_free_edges(res.shape) == res.free_edges


def test_faceted_closed_mesh_reports_zero_free_edges():
    box = trimesh.creation.box(extents=(0.02, 0.02, 0.02))
    res = faceted_shape(np.asarray(box.vertices, float), np.asarray(box.faces, np.int64))
    assert res.is_solid and res.free_edges == 0


def test_fitted_open_shell_reports_free_edges_and_not_solid():
    v, f = _open_box_arrays()
    res = fitted_shape(v, f)
    assert not res.is_solid
    assert res.free_edges > 0
    assert count_free_edges(res.shape) == res.free_edges


def test_fitted_closed_mesh_reports_zero_free_edges():
    box = trimesh.creation.box(extents=(0.02, 0.03, 0.04))
    res = fitted_shape(np.asarray(box.vertices, float), np.asarray(box.faces, np.int64))
    assert res.is_solid and res.free_edges == 0


def test_sphere_and_cone_routes_report_computed_zero_free_edges():
    # These used to hardcode free_edges=0; the count is now the real free-bounds result.
    sm = trimesh.creation.icosphere(subdivisions=3, radius=0.01)
    sphere = reconstruct_sphere(np.asarray(sm.vertices, float), np.asarray(sm.faces, np.int64))
    assert sphere.is_solid and sphere.free_edges == 0
    assert count_free_edges(sphere.shape) == 0

    cm = trimesh.creation.cone(radius=0.01, height=0.02, sections=48)
    cone = reconstruct_cone(np.asarray(cm.vertices, float), np.asarray(cm.faces, np.int64))
    assert cone.is_solid and cone.free_edges == 0
    assert count_free_edges(cone.shape) == 0


def test_revolution_route_reports_computed_zero_free_edges():
    m = trimesh.creation.cylinder(radius=0.01, height=0.03, sections=48)
    res = reconstruct_revolution(np.asarray(m.vertices, float), np.asarray(m.faces, np.int64))
    assert res is not None
    assert res.is_solid and res.free_edges == 0
    assert count_free_edges(res.shape) == 0
