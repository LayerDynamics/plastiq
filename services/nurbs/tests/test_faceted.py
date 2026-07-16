"""U7.4 — FR-5 faceted-fallback unit tests (``app.faceted``).

The faceted fallback is the FR-8 guarantee that the service ALWAYS returns a valid
B-rep STEP: any NURBS patch that misses ``fidelity_tol`` is replaced by per-triangle
planar faces of its mesh region, and the whole solid is assembled from the mix
(``pipeline_closed`` wires this; here we test the geometry primitives directly).

Two layers, both real OCCT (no mocks):

  * :func:`app.faceted.faceted_faces` — a mesh region's triangles → one planar OCC
    face each (degenerate slivers skipped), sewing into a shell.
  * :func:`app.faceted.assemble_mixed_solid` — NURBS surfaces JSON + faceted regions →
    a single crash-isolated sew → solid attempt → verified closure → STEP. Exercised
    here with the all-faceted extreme (a closed tetrahedron, no NURBS), which must come
    out a watertight solid — nothing dropped (FR-8).
"""

from __future__ import annotations

import numpy as np
import pytest
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPControl import STEPControl_Reader
from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
from OCC.Core.TopExp import TopExp_Explorer

from app.faceted import FacetedRegion, assemble_mixed_solid, faceted_faces, sew_faces

# A unit square in the z = 0 plane, split into two triangles sharing the 0->2 diagonal.
_SQUARE_V = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]])
_SQUARE_T = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int64)

# A closed tetrahedron (4 vertices, 4 triangles, every edge shared by exactly 2 faces).
_TETRA_V = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
_TETRA_T = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]], dtype=np.int64)


def _count(shape, topype) -> int:
    explorer = TopExp_Explorer(shape, topype)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def _reimport(step_text: str, tmp_path):
    path = tmp_path / "reimport.step"
    path.write_text(step_text, encoding="utf-8")
    reader = STEPControl_Reader()
    assert reader.ReadFile(str(path)) == IFSelect_RetDone
    assert reader.TransferRoots() > 0
    return reader.OneShape()


# --- faceted_faces: one valid planar face per triangle -------------------------------------


def test_faceted_faces_one_valid_face_per_triangle() -> None:
    """N non-degenerate triangles → N valid planar OCC faces (FR-5 per-triangle build)."""
    faces = faceted_faces(_SQUARE_V, _SQUARE_T)
    assert len(faces) == 2
    for face in faces:
        assert BRepCheck_Analyzer(face).IsValid(), "faceted face is not a valid B-rep face"


def test_faceted_faces_skips_degenerate_triangles() -> None:
    """A zero-area (collinear) triangle can build no face and is skipped, not crashed."""
    verts = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    tris = np.array([[0, 1, 2], [0, 1, 3]], dtype=np.int64)  # first is collinear (zero area)
    faces = faceted_faces(verts, tris)
    assert len(faces) == 1, "the collinear triangle must be skipped"
    assert BRepCheck_Analyzer(faces[0]).IsValid()


def test_faceted_faces_all_degenerate_raises() -> None:
    """No buildable triangle is an honest error, never a silently empty B-rep."""
    verts = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]])
    tris = np.array([[0, 1, 2]], dtype=np.int64)  # collinear
    with pytest.raises(ValueError, match="no valid|faceted"):
        faceted_faces(verts, tris)


# --- sew_faces: the mixed-sew helper builds a shell ----------------------------------------


def test_sew_faces_forms_a_shell() -> None:
    """The faceted region's faces sew into a connected shell (the mixed-sew helper)."""
    faces = faceted_faces(_SQUARE_V, _SQUARE_T)
    sewn, free_edges = sew_faces(faces)
    assert _count(sewn, TopAbs_SHELL) >= 1, "two edge-adjacent triangles must sew into a shell"
    # The open square has 4 naked boundary edges (the shared diagonal is not free).
    assert free_edges > 0


# --- assemble_mixed_solid: the all-faceted extreme is still a watertight solid (FR-8) ------


def test_assemble_all_faceted_tetra_is_watertight_solid(tmp_path) -> None:
    """No NURBS surfaces + one closed faceted region → a valid, watertight STEP solid.

    This is the FR-8 guarantee at its extreme (``fidelity_tol`` so tiny every patch
    facets): the assembly must still close, validate, and re-import as a solid — the
    service never drops geometry.
    """
    region = FacetedRegion(vertices=_TETRA_V, triangles=_TETRA_T)
    result = assemble_mixed_solid({"surfaces": []}, [region])

    assert result["is_solid"] is True, "a closed tetra must assemble into a solid"
    assert result["is_valid"] is True
    assert result["free_edges"] == 0
    assert result["faces"] == 4
    assert result["volume"] > 0.0

    shape = _reimport(result["step"], tmp_path)
    assert _count(shape, TopAbs_SOLID) == 1
    assert _count(shape, TopAbs_FACE) == 4
    assert "B_SPLINE_SURFACE_WITH_KNOTS" not in result["step"]  # all faceted, no NURBS


def test_assemble_all_faceted_deterministic() -> None:
    """Two isolated assemblies of the same region agree on closure and volume (NFR-1)."""
    region = FacetedRegion(vertices=_TETRA_V, triangles=_TETRA_T)
    a = assemble_mixed_solid({"surfaces": []}, [region])
    b = assemble_mixed_solid({"surfaces": []}, [region])
    assert a["is_solid"] == b["is_solid"]
    assert a["is_valid"] == b["is_valid"]
    assert a["free_edges"] == b["free_edges"]
    assert abs(a["volume"] - b["volume"]) <= 1e-12 * max(1.0, abs(a["volume"]))
