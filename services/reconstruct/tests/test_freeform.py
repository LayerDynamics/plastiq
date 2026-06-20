"""R6.5 — freeform faces (BRepOffsetAPI_MakeFilling) for smooth non-primitive regions."""

import numpy as np
import trimesh

from app.freeform import face_max_point_error, freeform_face, freeform_region_face


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
    # boundary IS the cap's rim (the shared mesh polyline). The boundary is respected exactly
    # (C0 edge constraints — the sew-critical guarantee); the interior is an energy-minimizing
    # approximation of the sphere (freeform, not an exact fit).
    m = trimesh.creation.icosphere(subdivisions=3, radius=0.02)
    cap = m.triangles_center[:, 2] > 0.012  # upper cap faces
    assert cap.sum() > 10
    cap_idx = np.nonzero(cap)[0]
    face = freeform_region_face(m, cap_idx)
    assert face is not None
    rim = np.asarray(m.outline(cap_idx).discrete[0])
    # The boundary is respected within MakeFilling's approximation tolerance (~1e-4) — close,
    # but NOT exact, which is why freeform needs per-region sew tolerance / the topology tail
    # before it can join a solid (it is NOT wired into the fitted sewing path; see SPEC-7 R6.5).
    assert face_max_point_error(face, rim) < 2e-4
    cap_verts = m.vertices[np.unique(m.faces[cap])]
    assert face_max_point_error(face, cap_verts) < 0.01  # interior: smooth approximation


def test_freeform_region_face_none_for_closed_region():
    # the whole sphere has no single boundary loop → not fillable as one patch → None
    m = trimesh.creation.icosphere(subdivisions=2, radius=0.02)
    assert freeform_region_face(m, np.arange(len(m.faces))) is None
