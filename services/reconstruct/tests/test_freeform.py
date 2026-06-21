"""R6.5 — freeform faces (BRepOffsetAPI_MakeFilling) for smooth non-primitive regions."""

import numpy as np
import trimesh

from app.freeform import (
    face_max_point_error,
    freeform_capped_solid,
    freeform_face,
    freeform_region_face,
)


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
