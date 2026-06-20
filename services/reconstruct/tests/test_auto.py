"""R6.4b — auto single-primitive classification through the pipeline (no mocks).

A primitive mesh reconstructs to its analytic solid; a box (whose corners lie on a
circumscribed circle/sphere) must NOT be misread as a primitive and falls back to fitted."""

import base64
from math import pi

import trimesh

from app.detect import try_single_primitive
from app.pipeline import reconstruct


def _glb(mesh: trimesh.Trimesh) -> bytes:
    return mesh.export(file_type="glb")


def test_auto_classifies_cylinder():
    res = reconstruct(_glb(trimesh.creation.cylinder(radius=0.01, height=0.03, sections=48)))
    assert res.report.method == "cylinder"
    assert res.report.primitive == "cylinder"
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")


def test_auto_classifies_sphere():
    res = reconstruct(_glb(trimesh.creation.icosphere(subdivisions=3, radius=0.012)))
    assert res.report.method == "sphere"
    assert res.report.is_solid


def test_auto_classifies_cone():
    res = reconstruct(_glb(trimesh.creation.cone(radius=0.01, height=0.025, sections=64)))
    assert res.report.method == "cone"
    assert res.report.is_solid


def test_auto_rejects_box_falls_back_to_fitted():
    # A box's 8 corners lie on a circumscribed sphere/circle — the shape gates must reject
    # the primitive hypotheses so it routes to the planar (fitted) path, not a fake cylinder.
    box = trimesh.creation.box(extents=(0.02, 0.03, 0.04))
    assert try_single_primitive(box.vertices, box.faces) is None
    res = reconstruct(_glb(box))
    assert res.report.method == "fitted"
    assert res.report.planar_faces == 6
    assert res.report.is_solid
