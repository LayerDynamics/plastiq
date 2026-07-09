"""Fitted reconstruction (R6.3/R6.4): planar facets collapse into single trimmed faces,
producing a far more compact B-rep than the faceted baseline."""

import numpy as np
import trimesh

from app.faceted import faceted_shape
from app.fitted import fitted_shape
from app.occ_step import shape_to_step
from app.pipeline import reconstruct


def _arrays(mesh: trimesh.Trimesh) -> tuple[np.ndarray, np.ndarray]:
    return np.asarray(mesh.vertices, dtype=float), np.asarray(mesh.faces, dtype=np.int64)


def test_box_collapses_to_six_planar_faces_as_a_solid():
    v, f = _arrays(trimesh.creation.box(extents=(0.02, 0.03, 0.04)))
    res = fitted_shape(v, f)
    assert res.planar_faces == 6  # 12 triangles → 6 trimmed faces
    assert res.triangle_faces == 0
    assert res.is_solid
    assert res.is_valid


def test_cylinder_caps_and_side_quads_are_planar_faces():
    # 2 flat caps + 24 side quads → 26 planar facets (no curved-surface fitting yet).
    v, f = _arrays(trimesh.creation.cylinder(radius=0.01, height=0.03, sections=24))
    res = fitted_shape(v, f)
    assert res.planar_faces == 26
    assert res.is_valid


def test_fitted_step_is_smaller_than_faceted_for_a_box():
    v, f = _arrays(trimesh.creation.box(extents=(0.02, 0.02, 0.02)))
    fitted_step = shape_to_step(fitted_shape(v, f).shape)
    faceted_step = shape_to_step(faceted_shape(v, f).shape)
    assert len(fitted_step) < len(faceted_step)  # fewer faces → smaller STEP


def test_pipeline_default_auto_falls_through_to_fitted_for_a_box():
    # The pipeline's default method is "auto" (analytic routes first); a plain box matches
    # no analytic route (primitive/revolution/CSG/cut-cylinder) and falls through to fitted.
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    res = reconstruct(glb, "glb")
    assert res.report.method == "fitted"
    assert res.report.planar_faces == 6
    assert res.report.faces_built == 6
    assert res.report.is_solid
    assert res.report.is_valid
    assert res.step.startswith("ISO-10303-21")
