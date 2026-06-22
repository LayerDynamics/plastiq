"""M2c — mesh-side feature recognition (app/recognition.py): the same clean-room tangent-adjacency
idea as the @plastiq/cad selectors, computed over a triangle mesh via trimesh face adjacency +
dihedral angles. Groups triangles into tangent-connected (smooth) regions and flags curved ones, so
the reconstruction report can honestly describe the part's structure (NFR-4). See docs/adr/0002.
"""

import glob
import os

import numpy as np
import trimesh

from app.cleanup import clean_mesh
from app.pipeline import reconstruct
from app.recognition import group_tangent_regions, recognize


def _arrays(m: trimesh.Trimesh) -> tuple[np.ndarray, np.ndarray]:
    v, f = clean_mesh(np.asarray(m.vertices, dtype=float), np.asarray(m.faces, dtype=np.int64))
    return v, f


def test_box_is_six_flat_tangent_regions():
    v, f = _arrays(trimesh.creation.box(extents=(0.03, 0.02, 0.01)))
    labels = group_tangent_regions(v, f)
    assert len(set(labels.tolist())) == 6  # six faces, all meeting at sharp 90° edges
    r = recognize(v, f)
    assert r["tangent_regions"] == 6
    assert r["curved_regions"] == 0  # a box has no curved face


def test_cylinder_has_one_curved_lateral_region_plus_two_caps():
    v, f = _arrays(trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48))
    r = recognize(v, f)
    assert r["tangent_regions"] == 3  # smooth lateral + 2 flat caps
    assert r["curved_regions"] == 1  # the lateral cylindrical face is curved


def test_domed_box_fixture_has_a_curved_region():
    fx = os.path.join(os.path.dirname(__file__), "fixtures", "domed_box.glb")
    if not os.path.exists(fx):
        # the fixture set ships these; guard so the suite is robust if one is absent
        return
    scene = trimesh.load(fx, force="mesh")
    v, f = _arrays(scene)
    r = recognize(v, f)
    assert r["curved_regions"] >= 1  # the dome


def test_recognition_is_deterministic():
    v, f = _arrays(trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48))
    assert recognize(v, f) == recognize(v, f)
    assert np.array_equal(group_tangent_regions(v, f), group_tangent_regions(v, f))


# ── pipeline integration (M2c.2) — the report carries the recognition count ──

def test_report_carries_tangent_regions_box():
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    r = reconstruct(glb, "glb", method="auto").report
    assert r.tangent_regions == 6  # six flat faces


def test_report_carries_tangent_regions_cylinder():
    glb = trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48).export(file_type="glb")
    r = reconstruct(glb, "glb", method="auto").report
    assert r.tangent_regions == 3  # curved lateral + 2 caps
