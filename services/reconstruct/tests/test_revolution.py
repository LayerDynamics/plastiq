"""R6.4b-ii — surface-of-revolution (turned-part) reconstruction: a MIXED-shape solid
(stepped shaft = two cylinders + planar shoulders) → one analytic revolved solid with exact
shared circle edges. Self-validated by volume; non-revolutions (a box) are rejected."""

from math import pi

import numpy as np
import trimesh

from app.pipeline import reconstruct
from app.revolution import reconstruct_revolution, revolve_profile

# Stepped shaft: r=0.010 over z[0,0.020], r=0.006 over z[0.020,0.035].
_PROFILE = np.array([[0, 0], [0.010, 0], [0.010, 0.020], [0.006, 0.020], [0.006, 0.035], [0, 0.035]])
_EXP_VOL = pi * 0.010**2 * 0.020 + pi * 0.006**2 * 0.015


def _stepped_shaft(sections: int = 64) -> trimesh.Trimesh:
    return trimesh.creation.revolve(_PROFILE, sections=sections)


def _glb(mesh: trimesh.Trimesh) -> bytes:
    return mesh.export(file_type="glb")


def test_revolve_profile_builds_stepped_solid():
    # profile as (a=axial, b=radial) about +Z through the origin
    prof = np.column_stack([_PROFILE[:, 1], _PROFILE[:, 0]])  # (z, r) → (a, b)
    res = revolve_profile(prof, np.zeros(3), np.array([0, 0, 1.0]))
    assert res.is_solid and res.is_valid
    assert res.n_faces == 5  # bottom disk + r1 cylinder + shoulder annulus + r2 cylinder + top disk
    assert abs(res.volume - _EXP_VOL) < 1e-9


def test_reconstruct_revolution_from_mesh():
    m = _stepped_shaft()
    res = reconstruct_revolution(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res is not None
    assert res.is_solid
    assert abs(res.volume - _EXP_VOL) / _EXP_VOL < 0.02


def test_auto_pipeline_classifies_stepped_shaft_as_revolution():
    res = reconstruct(_glb(_stepped_shaft()))
    assert res.report.method == "revolution"
    assert res.report.is_solid
    assert res.report.faces_built >= 4  # multiple analytic faces, not a faceted shell
    assert res.step.startswith("ISO-10303-21")


def test_revolution_rejects_a_box():
    box = trimesh.creation.box(extents=(0.02, 0.03, 0.04))
    # revolving a box's rectangular half-section makes a cylinder whose volume ≠ the box's,
    # so the volume gate rejects it (→ caller falls back to fitted).
    assert reconstruct_revolution(box.vertices, box.faces) is None
    assert reconstruct(_glb(box)).report.method == "fitted"
