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
