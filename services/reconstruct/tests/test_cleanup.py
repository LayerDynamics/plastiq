"""Mesh cleanup (R6.2): welding + degenerate/duplicate removal + repair, and that a
cleaned messy-but-near-watertight mesh reconstructs to a solid."""

import numpy as np
import trimesh

from app.cleanup import clean_mesh
from app.pipeline import reconstruct


def test_welds_coincident_vertices_and_drops_degenerate():
    # Two triangles forming a quad, but the shared edge uses DUPLICATE (unwelded)
    # vertices, plus one zero-area sliver triangle.
    v = np.array(
        [
            [0, 0, 0],  # 0
            [1, 0, 0],  # 1
            [1, 1, 0],  # 2
            [0, 0, 0],  # 3 == 0 (duplicate, unwelded)
            [1, 1, 0],  # 4 == 2 (duplicate, unwelded)
            [0, 1, 0],  # 5
        ],
        dtype=float,
    )
    f = np.array([[0, 1, 2], [3, 4, 5], [0, 1, 1]], dtype=np.int64)  # last = degenerate
    cv, cf = clean_mesh(v, f, fill_holes=False)
    assert len(cv) == 4  # 6 → 4 after welding the two duplicate pairs
    assert len(cf) == 2  # the degenerate sliver is gone


def test_cleaned_box_still_reconstructs_to_a_solid():
    glb = trimesh.creation.box(extents=(0.02, 0.02, 0.02)).export(file_type="glb")
    res = reconstruct(glb, "glb", clean=True)
    assert res.report.is_solid
    assert res.report.is_valid
    assert res.report.triangles_in == 12
    assert res.report.triangles_used == 12  # a clean box loses no triangles


def test_report_exposes_raw_vs_used_triangle_counts():
    # An icosphere with duplicated geometry collapses on cleanup; used <= raw.
    glb = trimesh.creation.icosphere(subdivisions=1, radius=0.02).export(file_type="glb")
    res = reconstruct(glb, "glb", clean=True)
    assert res.report.triangles_used <= res.report.triangles_in
    assert res.report.is_valid
