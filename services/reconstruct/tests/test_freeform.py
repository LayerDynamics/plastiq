"""R6.5 — freeform faces (BRepOffsetAPI_MakeFilling) for smooth non-primitive regions."""

import os

import numpy as np
import trimesh

from app.fitted import _solid_volume, fitted_shape
from app.freeform import (
    face_max_point_error,
    freeform_capped_solid,
    freeform_face,
    freeform_region_face,
)
from app.pipeline import reconstruct

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _glb(name: str) -> bytes:
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def test_freeform_face_from_boundary_and_interior_point():
    # square boundary at z=0 + a raised apex → a smooth dome patch passing near the apex
    boundary = np.array([[0, 0, 0], [0.02, 0, 0], [0.02, 0.02, 0], [0, 0.02, 0]], dtype=float)
    apex = np.array([[0.01, 0.01, 0.004]])
    face = freeform_face(boundary, apex)
    assert face is not None
    assert face_max_point_error(face, apex) < 1e-3  # the fill passes near the constraint


def test_freeform_face_rejects_too_few_points():
    assert freeform_face(np.array([[0, 0, 0], [1, 0, 0]], dtype=float)) is None


def test_freeform_region_face_on_a_sphere_cap():
    # an OPEN curved patch (the top cap of an icosphere) → one smooth freeform face whose
    # boundary IS the cap's rim (the shared mesh polyline), so it sews with planar/faceted
    # neighbours (used by the fitted path, below). The interior is an energy-minimizing
    # approximation of the sphere, refined by the interior-count ladder.
    m = trimesh.creation.icosphere(subdivisions=3, radius=0.02)
    cap = m.triangles_center[:, 2] > 0.012  # upper cap faces
    assert cap.sum() > 10
    cap_idx = np.nonzero(cap)[0]
    face = freeform_region_face(m, cap_idx)
    assert face is not None
    rim = np.asarray(m.outline(cap_idx).discrete[0])
    assert face_max_point_error(face, rim) < 2e-4  # boundary respected (sew-critical)
    cap_verts = m.vertices[np.unique(m.faces[cap])]
    # Interior accuracy: the ladder (richer interior constraints) keeps this well under 1 mm —
    # far better than the old fixed 10-point cap (~2.6 mm on this radius).
    assert face_max_point_error(face, cap_verts) < 1e-3


def test_freeform_region_face_none_for_closed_region():
    # the whole sphere has no single boundary loop → not fillable as one patch → None
    m = trimesh.creation.icosphere(subdivisions=2, radius=0.02)
    assert freeform_region_face(m, np.arange(len(m.faces))) is None


# --- R6.5 topology integration: a freeform cap that JOINS a watertight solid -----------------


def test_freeform_capped_solid_is_watertight_and_volume_matches():
    # An open box (bottom + 4 walls) capped by a freeform top whose boundary is the SAME square
    # rim the walls use (coincident boundaries) → sews into a watertight SOLID (NbFreeEdges==0),
    # not just a shell. This is the case where freeform really joins a solid (R6.5).
    a, h, bump = 0.04, 0.01, 0.004
    base = [(0, 0, 0), (a, 0, 0), (a, a, 0), (0, a, 0)]
    top = [(0, 0, h), (a, 0, h), (a, a, h), (0, a, h)]
    side_loops = [np.array(base, dtype=float)]  # bottom
    for i in range(4):  # 4 walls, each sharing a top rim edge with the cap
        side_loops.append(np.array([base[i], base[(i + 1) % 4], top[(i + 1) % 4], top[i]], dtype=float))
    cap_boundary = np.array(top, dtype=float)
    cap_interior = np.array([[a / 2, a / 2, h + bump]], dtype=float)  # a raised apex → a bulged cap

    res = freeform_capped_solid(side_loops, cap_boundary, cap_interior)
    assert res is not None
    assert res.is_solid and res.is_valid
    assert res.n_faces == 6  # bottom + 4 walls + freeform cap
    box_vol = a * a * h
    # The bulged cap adds material above the box top → strictly more than the bare box, and
    # bounded by the box + its bounding prism over the bump.
    assert box_vol < res.volume < box_vol + a * a * bump


def test_freeform_capped_solid_rejects_open_boundary():
    # Missing a wall → the rim can't close → NbFreeEdges>0 → None (no fragile output).
    a, h = 0.04, 0.01
    base = [(0, 0, 0), (a, 0, 0), (a, a, 0), (0, a, 0)]
    top = [(0, 0, h), (a, 0, h), (a, a, h), (0, a, h)]
    side_loops = [np.array(base, dtype=float)]
    for i in range(3):  # only 3 of 4 walls → an open side
        side_loops.append(np.array([base[i], base[(i + 1) % 4], top[(i + 1) % 4], top[i]], dtype=float))
    res = freeform_capped_solid(side_loops, np.array(top, dtype=float), np.array([[a / 2, a / 2, h + 0.004]]))
    assert res is None


# --- R6.5 PIPELINE integration: fitted/auto collapse curved regions into freeform faces ------


def test_fitted_pipeline_uses_freeform_faces_on_a_domed_box():
    # A box with a smooth domed top (flat sides + a curved top bounded by the rim) is NOT a
    # primitive/revolution/CSG, so `auto` falls to `fitted` — which now collapses the curved
    # region into freeform faces. The DISCRIMINATOR that proves freeform really ran (not the
    # per-triangle faceted fallback, which would also be is_solid): report.freeform_faces > 0.
    glb = _glb("domed_box.glb")
    res = reconstruct(glb, method="fitted")
    assert res.report.method == "fitted"
    assert res.report.freeform_faces > 0
    assert res.report.planar_faces >= 5  # the 4 walls + bottom collapse to single planar faces
    assert res.report.is_solid and res.report.is_valid
    assert res.step.startswith("ISO-10303-21")
    # Far more compact than the per-triangle faceted baseline.
    faceted = reconstruct(glb, method="faceted")
    assert res.report.faces_built < faceted.report.faces_built / 2


def test_auto_falls_through_to_freeform_fitted_for_domed_box():
    res = reconstruct(_glb("domed_box.glb"))  # default method="auto"
    assert res.report.method == "fitted"
    assert res.report.freeform_faces > 0
    assert res.report.is_solid


def test_fitted_volume_preserved_with_freeform():
    # Freeform is the only APPROXIMATE path, so volume-match is the load-bearing check: drive
    # fitted_shape directly and compare the freeform-capped solid's volume to the source mesh
    # (the pipeline's volume guard would have rebuilt faceted-only on a gross drift).
    m = trimesh.load(os.path.join(FIX, "domed_box.glb"), process=False)
    m = m.to_geometry() if isinstance(m, trimesh.Scene) else m
    res = fitted_shape(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res.is_solid and res.freeform_faces > 0
    mesh_vol = abs(float(m.volume))
    assert abs(_solid_volume(res.shape) - mesh_vol) / mesh_vol < 0.05


def test_fitted_falls_back_to_faceted_for_a_closed_region():
    # A closed curved region (a whole sphere) has NO boundary loop, so it can't be one filled
    # patch — freeform must NOT engage, and the result is a valid faceted solid (the honest,
    # fundamental fallback). method="fitted" bypasses the sphere PRIMITIVE detector on purpose.
    m = trimesh.creation.icosphere(subdivisions=2, radius=0.02)
    res = fitted_shape(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res.freeform_faces == 0  # no boundary loop → no freeform attempted
    assert res.is_solid and res.is_valid  # faceted fallback is still a valid watertight solid
