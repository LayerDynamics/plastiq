"""R6.4b-iii — CSG / boolean reconstruction of non-coaxial mixed parts (box with
cylindrical through-holes), via OCCT booleans (the InverseCSG paradigm). Self-validated by
volume; parts outside the bounded scope (boss, pure primitives) are rejected → other paths."""

import os
from math import pi

import numpy as np
import trimesh

from app.csg import reconstruct_csg
from app.pipeline import reconstruct

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _load(name: str) -> trimesh.Trimesh:
    m = trimesh.load(os.path.join(FIX, name), process=False)
    return m.to_geometry() if isinstance(m, trimesh.Scene) else m


def _glb(name: str) -> bytes:
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def test_box_with_hole_reconstructs_via_boolean_cut():
    m = _load("box_with_hole.glb")
    res = reconstruct_csg(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res is not None
    assert res.is_solid and res.is_valid
    assert res.n_faces == 7  # 4 box sides + 2 annular caps + 1 cylindrical hole wall
    assert abs(res.volume - abs(float(m.volume))) / abs(float(m.volume)) < 0.03


def test_box_with_hole_volume_matches_box_minus_cylinder():
    m = _load("box_with_hole.glb")
    res = reconstruct_csg(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    expected = 0.04 * 0.03 * 0.01 - pi * 0.006**2 * 0.01
    assert abs(res.volume - expected) / expected < 0.02


def test_box_with_boss_reconstructs_via_boolean_fuse():
    # A protruding cylindrical boss (additive) → Fuse(box, cylinder); the base box is taken
    # from the dominant planar faces, so the boss top doesn't inflate it.
    m = _load("box_with_boss.glb")
    res = reconstruct_csg(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res is not None
    assert res.is_solid and res.is_valid
    assert res.volume > 0.04 * 0.03 * 0.01  # strictly more than the bare box (material added)
    assert abs(res.volume - abs(float(m.volume))) / abs(float(m.volume)) < 0.03


def test_auto_pipeline_classifies_box_with_hole_as_csg():
    for fixture in ("box_with_hole.glb", "box_with_boss.glb"):
        res = reconstruct(_glb(fixture))
        assert res.report.method == "csg", fixture
        assert res.report.is_solid
        assert res.step.startswith("ISO-10303-21")


def test_csg_rejects_out_of_scope_parts():
    # A pure cylinder and a stepped shaft are NOT box+feature CSG — their own paths handle them.
    for name in ("cylinder.glb", "stepped_shaft.glb"):
        m = _load(name)
        assert reconstruct_csg(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64)) is None, name


# --- R6.4b general CSG: non-axis-aligned (rotated) base + multi-feature ---------------------


def test_rotated_box_with_hole_reconstructs_via_oriented_frame():
    # The box is rotated 33° off the world axes, so NO face is axis-aligned: the world-aligned
    # base path can't apply, and reconstruction must derive the box's own oriented frame.
    m = _load("box_with_hole_rotated.glb")
    res = reconstruct_csg(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res is not None
    assert res.is_solid and res.is_valid
    assert res.n_faces > 6  # more than a bare box → the hole is really there
    assert abs(res.volume - abs(float(m.volume))) / abs(float(m.volume)) < 0.03


def test_auto_pipeline_classifies_rotated_box_as_csg():
    # The discriminator that proves the ANALYTIC CSG path ran (not the faceted/fitted fallback,
    # which would also report is_solid=True): the method must be "csg" AND the volume must match.
    res = reconstruct(_glb("box_with_hole_rotated.glb"))
    assert res.report.method == "csg"
    assert res.report.primitive == "csg"
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")


def test_box_with_two_holes_multi_feature_cut():
    # Multi-feature: a box with TWO through-holes → two BRepAlgoAPI_Cut ops, volume validated
    # against box − 2 cylinders.
    m = _load("box_with_two_holes.glb")
    res = reconstruct_csg(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res is not None and res.is_solid and res.is_valid
    expected = 0.04 * 0.03 * 0.01 - 2 * pi * 0.004**2 * 0.01
    assert abs(res.volume - expected) / expected < 0.02
    assert reconstruct(_glb("box_with_two_holes.glb")).report.method == "csg"
