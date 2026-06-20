"""Real reconstruction geometry (no mocks): triangle meshes → valid B-rep STEP."""

import numpy as np
import trimesh

from app.faceted import faceted_shape
from app.occ_step import shape_to_step
from app.pipeline import reconstruct


def _cube_arrays(size: float = 0.02) -> tuple[np.ndarray, np.ndarray]:
    box = trimesh.creation.box(extents=(size, size, size))
    return np.asarray(box.vertices, dtype=float), np.asarray(box.faces, dtype=np.int64)


def test_watertight_cube_reconstructs_to_valid_solid():
    v, f = _cube_arrays()
    res = faceted_shape(v, f)
    assert res.faces_built == 12  # 6 faces × 2 triangles
    assert res.is_valid
    assert res.is_solid  # a closed cube sews into a solid


def test_step_output_is_a_real_step_file():
    v, f = _cube_arrays()
    step = shape_to_step(faceted_shape(v, f).shape)
    assert step.startswith("ISO-10303-21")
    assert "END-ISO-10303-21" in step


def test_reconstruct_glb_end_to_end():
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    res = reconstruct(glb, "glb")
    assert res.report.method == "faceted"
    assert res.report.is_valid
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")


def test_degenerate_triangles_are_skipped():
    # A quad (two good triangles) plus a zero-area sliver (repeated vertex index).
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=float)
    f = np.array([[0, 1, 2], [0, 2, 3], [0, 1, 1]], dtype=np.int64)
    res = faceted_shape(v, f)
    assert res.faces_built == 2  # the degenerate triangle was dropped


def test_open_mesh_falls_back_to_a_shell_not_a_solid():
    # A single triangle is an open shell — valid B-rep, but not a closed solid.
    v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=float)
    f = np.array([[0, 1, 2]], dtype=np.int64)
    res = faceted_shape(v, f)
    assert res.faces_built == 1
    assert res.is_solid is False
    assert res.is_valid
