"""U7.1 — cube-map 6-chart layout + shared boundary polylines (SPEC-12 FR-4, §5.1, R-1).

Contracts under test (U7.2's shared boundary-curve fitting consumes them):

- every face of a closed genus-0 mesh lands in exactly one of 6 charts, keyed by
  dominant face normal in the fixed direction order +x, -x, +y, -y, +z, -z
  (chart index == direction index; argmax ties go to the lowest index);
- a deterministic repair pass leaves every chart non-empty, edge-connected, and
  disk-topology (one boundary loop, Euler characteristic 1);
- every chart-boundary edge is shared by exactly 2 charts, and adjacent charts
  reference the IDENTICAL polyline table entry (orientation flag aside) — the
  watertight-by-construction mechanism (SPEC-12 R-1);
- polylines run junction-to-junction (vertices where >= 3 charts meet) or close
  into a loop between exactly 2 charts;
- each chart's submesh maps to the unit square via the landed harmonic_disk_map
  with zero flipped uv triangles and its boundary on the square perimeter;
- fully deterministic: two runs are bitwise identical (NFR-1, no RNG anywhere).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import trimesh

from app.meshio import boundary_loops, load_mesh
from app.param import (
    UnsupportedTopologyError,
    _chart_corner_locals,
    _junction_vertices,
    _orient_to_face_winding,
    cube_map_charts,
    flipped_uv_triangles,
    harmonic_disk_map_pinned,
)

SQUARE_CORNERS = {(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)}

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# Direction order fixed by the implementation: chart index == direction index.
PLUS_X, MINUS_X, PLUS_Y, MINUS_Y, PLUS_Z, MINUS_Z = range(6)


def _blob() -> trimesh.Trimesh:
    return load_mesh((FIXTURES / "blob.glb").read_bytes())


def _dome() -> trimesh.Trimesh:
    return load_mesh((FIXTURES / "dome.glb").read_bytes())


def _cube() -> trimesh.Trimesh:
    """Hand-built unit cube, 2 consistently-wound CCW (outward) triangles per side.

    Face indices are grouped per side in chart order: faces (2i, 2i+1) belong to
    direction i of (+x, -x, +y, -y, +z, -z) — the ideal partition is unambiguous
    (each face normal hits dot = 1.0 for its own direction, <= 0.0 elsewhere).
    """
    vertices = np.array(
        [
            [0.0, 0.0, 0.0],  # 0
            [1.0, 0.0, 0.0],  # 1
            [1.0, 1.0, 0.0],  # 2
            [0.0, 1.0, 0.0],  # 3
            [0.0, 0.0, 1.0],  # 4
            [1.0, 0.0, 1.0],  # 5
            [1.0, 1.0, 1.0],  # 6
            [0.0, 1.0, 1.0],  # 7
        ]
    )
    faces = np.array(
        [
            [1, 2, 6], [1, 6, 5],  # +x
            [3, 0, 4], [3, 4, 7],  # -x
            [2, 3, 7], [2, 7, 6],  # +y
            [0, 1, 5], [0, 5, 4],  # -y
            [4, 5, 6], [4, 6, 7],  # +z
            [0, 3, 2], [0, 2, 1],  # -z
        ]
    )
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


# Cube edge -> the two adjacent sides (chart ids), for the inline-cube polyline test.
CUBE_EDGE_CHARTS = {
    frozenset({0, 1}): (MINUS_Y, MINUS_Z),
    frozenset({1, 2}): (PLUS_X, MINUS_Z),
    frozenset({2, 3}): (PLUS_Y, MINUS_Z),
    frozenset({3, 0}): (MINUS_X, MINUS_Z),
    frozenset({4, 5}): (MINUS_Y, PLUS_Z),
    frozenset({5, 6}): (PLUS_X, PLUS_Z),
    frozenset({6, 7}): (PLUS_Y, PLUS_Z),
    frozenset({7, 4}): (MINUS_X, PLUS_Z),
    frozenset({0, 4}): (MINUS_X, MINUS_Y),
    frozenset({1, 5}): (PLUS_X, MINUS_Y),
    frozenset({2, 6}): (PLUS_X, PLUS_Y),
    frozenset({3, 7}): (MINUS_X, PLUS_Y),
}


def _submesh(mesh: trimesh.Trimesh, chart) -> trimesh.Trimesh:
    """Rebuild a chart's submesh from its global faces + local->global vertex map."""
    local_faces = np.searchsorted(chart.vertex_map, np.asarray(mesh.faces)[chart.faces])
    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices, dtype=np.float64)[chart.vertex_map],
        faces=local_faces,
        process=False,
    )


def _face_labels(mesh: trimesh.Trimesh, result) -> np.ndarray:
    """Chart id per global face index (relies on the full-partition contract)."""
    labels = np.full(len(mesh.faces), -1, dtype=np.int64)
    for chart_id, chart in enumerate(result.charts):
        labels[chart.faces] = chart_id
    assert not np.any(labels < 0)
    return labels


def _vertex_charts(mesh: trimesh.Trimesh, result) -> dict[int, set[int]]:
    """Set of chart ids incident to each vertex (junction iff >= 3)."""
    labels = _face_labels(mesh, result)
    incident: dict[int, set[int]] = {}
    for face, label in zip(np.asarray(mesh.faces), labels):
        for vertex in face:
            incident.setdefault(int(vertex), set()).add(int(label))
    return incident


def _chart_boundary_edges(mesh: trimesh.Trimesh, chart) -> set[tuple[int, int]]:
    """Global sorted vertex pairs of the chart submesh's boundary edges."""
    sub = _submesh(mesh, chart)
    edges = sub.edges_sorted
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    return {
        (int(chart.vertex_map[a]), int(chart.vertex_map[b])) for a, b in unique[counts == 1]
    }


def _normalize_cycle(cycle) -> tuple[int, ...]:
    """Canonical form of a closed vertex cycle: rotation- and direction-invariant."""
    forms = []
    for sequence in (list(cycle), list(reversed(cycle))):
        pivot = sequence.index(min(sequence))
        forms.append(tuple(sequence[pivot:] + sequence[:pivot]))
    return min(forms)


def _reconstruct_boundary_cycle(result, chart) -> list[int]:
    """Rebuild the chart's boundary loop from its (polyline ref, reversed) sequence."""
    # Single closed-loop boundary: defensive/unreachable for the 6-chart cube-map layout
    # (every chart boundary carries >= 1 junction and so splits into open polylines);
    # kept for a possible future non-cube-map layout.
    if len(chart.boundary) == 1 and result.polylines[chart.boundary[0][0]].is_loop:
        index, reverse = chart.boundary[0]
        vertices = list(result.polylines[index].vertices)
        return vertices[::-1] if reverse else vertices
    cycle: list[int] = []
    for index, reverse in chart.boundary:
        vertices = list(result.polylines[index].vertices)
        if reverse:
            vertices = vertices[::-1]
        if cycle:
            assert cycle[-1] == vertices[0], "consecutive boundary segments must chain"
            cycle.pop()
        cycle.extend(vertices)
    assert cycle[0] == cycle[-1], "boundary segments must close into a loop"
    return cycle[:-1]


# --- blob.glb: partition + disk topology ------------------------------------------------


def test_blob_every_face_in_exactly_one_chart() -> None:
    mesh = _blob()
    result = cube_map_charts(mesh)
    assert len(result.charts) == 6
    for chart_id, chart in enumerate(result.charts):
        assert chart.direction == chart_id
        assert len(chart.faces) > 0, f"chart {chart_id} is empty"
    all_faces = np.concatenate([chart.faces for chart in result.charts])
    assert len(all_faces) == len(mesh.faces)
    assert np.array_equal(np.sort(all_faces), np.arange(len(mesh.faces)))


def test_blob_charts_are_disks() -> None:
    mesh = _blob()
    result = cube_map_charts(mesh)
    for chart_id, chart in enumerate(result.charts):
        sub = _submesh(mesh, chart)
        loops = boundary_loops(sub)  # raises on a non-manifold (pinched) boundary
        euler = len(sub.vertices) - len(sub.edges_unique) + len(sub.faces)
        assert len(loops) == 1, f"chart {chart_id}: {len(loops)} boundary loops"
        assert euler == 1, f"chart {chart_id}: Euler characteristic {euler}"


def test_blob_vertex_maps_are_sorted_and_consistent() -> None:
    mesh = _blob()
    result = cube_map_charts(mesh)
    for chart in result.charts:
        assert np.array_equal(chart.vertex_map, np.sort(chart.vertex_map))
        used = np.unique(np.asarray(mesh.faces)[chart.faces])
        assert np.array_equal(chart.vertex_map, used)


# --- blob.glb: shared boundary polylines -------------------------------------------------


def test_blob_boundary_edges_shared_by_exactly_two_charts() -> None:
    mesh = _blob()
    result = cube_map_charts(mesh)
    edge_charts: dict[tuple[int, int], list[int]] = {}
    for chart_id, chart in enumerate(result.charts):
        for edge in _chart_boundary_edges(mesh, chart):
            edge_charts.setdefault(edge, []).append(chart_id)
    assert edge_charts, "closed mesh split into 6 charts must have boundary edges"
    for edge, chart_ids in edge_charts.items():
        assert len(chart_ids) == 2, f"boundary edge {edge} in charts {chart_ids}"


def test_blob_polylines_cover_both_charts_identically() -> None:
    mesh = _blob()
    result = cube_map_charts(mesh)

    # Every polyline is referenced exactly once by each of its two charts, and the
    # two charts traverse the SAME table entry in opposite directions.
    references: dict[int, list[tuple[int, bool]]] = {}
    for chart_id, chart in enumerate(result.charts):
        for index, reverse in chart.boundary:
            references.setdefault(index, []).append((chart_id, reverse))
    assert sorted(references) == list(range(len(result.polylines)))
    for index, entries in references.items():
        polyline = result.polylines[index]
        assert sorted(chart_id for chart_id, _ in entries) == list(polyline.charts)
        assert entries[0][1] != entries[1][1], (
            f"polyline {index}: both charts traverse it in the same direction"
        )

    # Rebuilding each chart's boundary loop purely from the shared table reproduces
    # the chart submesh's own boundary loop — the sequences are identical.
    for chart in result.charts:
        sub = _submesh(mesh, chart)
        expected = [int(chart.vertex_map[v]) for v in boundary_loops(sub)[0]]
        rebuilt = _reconstruct_boundary_cycle(result, chart)
        assert _normalize_cycle(rebuilt) == _normalize_cycle(expected)


def test_blob_polyline_endpoints_are_junctions_or_closed_loops() -> None:
    mesh = _blob()
    result = cube_map_charts(mesh)
    incident = _vertex_charts(mesh, result)
    for polyline in result.polylines:
        assert polyline.charts == tuple(sorted(polyline.charts))
        assert len(set(polyline.vertices)) == len(polyline.vertices)
        # is_loop polylines are defensive/unreachable for the 6-chart cube-map layout
        # (every chart pair's shared boundary runs junction-to-junction); this branch is
        # kept to document the contract for a possible future non-cube-map layout.
        if polyline.is_loop:
            assert len(polyline.vertices) >= 3
            for vertex in polyline.vertices:
                assert incident[vertex] == set(polyline.charts)
        else:
            assert len(polyline.vertices) >= 2
            for endpoint in (polyline.vertices[0], polyline.vertices[-1]):
                assert len(incident[endpoint]) >= 3, (
                    f"open polyline endpoint {endpoint} is not a junction vertex"
                )
            for vertex in polyline.vertices[1:-1]:
                assert incident[vertex] == set(polyline.charts)


# --- blob.glb: per-chart uv ---------------------------------------------------------------


def test_blob_chart_uv_maps_are_flip_free_unit_square_disks() -> None:
    mesh = _blob()
    result = cube_map_charts(mesh)
    for chart_id, chart in enumerate(result.charts):
        sub = _submesh(mesh, chart)
        assert chart.uv.shape == (len(chart.vertex_map), 2)
        assert chart.uv.dtype == np.float64
        assert np.isfinite(chart.uv).all()
        assert flipped_uv_triangles(sub, chart.uv).size == 0, f"chart {chart_id} has flips"
        boundary_uv = chart.uv[np.asarray(boundary_loops(sub)[0])]
        assert np.all(boundary_uv >= 0.0) and np.all(boundary_uv <= 1.0)
        on_edge = (boundary_uv == 0.0) | (boundary_uv == 1.0)
        assert on_edge.any(axis=1).all(), f"chart {chart_id} boundary off the square perimeter"


# --- closed mode: uv corners pinned at chart junctions (U7.1-rev) -------------------------


def _chart_junction_locals(mesh, result, chart) -> list[int]:
    """Local vertex indices of the chart's boundary vertices that are junctions."""
    junctions = _junction_vertices(np.asarray(mesh.faces), _face_labels(mesh, result))
    return [
        local for local, glob in enumerate(chart.vertex_map) if int(glob) in junctions
    ]


def test_blob_chart_uv_corners_sit_at_the_four_junctions() -> None:
    # The four uv-square corners must land EXACTLY on the chart's four junction
    # vertices (U7.1-rev) — NOT at arbitrary quarter-arc-length boundary vertices —
    # so every shared boundary polyline maps to exactly one uv side.
    mesh = _blob()
    result = cube_map_charts(mesh)
    for chart_id, chart in enumerate(result.charts):
        junction_locals = _chart_junction_locals(mesh, result, chart)
        assert len(junction_locals) == 4, f"chart {chart_id}: {len(junction_locals)} junctions"
        corner_uvs = {tuple(chart.uv[local]) for local in junction_locals}
        assert corner_uvs == SQUARE_CORNERS, f"chart {chart_id}: junction uv {corner_uvs}"
        # Conversely, no non-junction boundary vertex sits at a square corner: every
        # other boundary vertex lies strictly inside one side (exactly one of u/v in
        # {0, 1}), so the four corners are pinned to the four junctions and nowhere else.
        sub = _submesh(mesh, chart)
        loop_local = [int(v) for v in boundary_loops(sub)[0]]
        for local in loop_local:
            if local in junction_locals:
                continue
            u, v = chart.uv[local]
            on_u = u in (0.0, 1.0)
            on_v = v in (0.0, 1.0)
            assert on_u != on_v, f"chart {chart_id} vertex {local} uv {(u, v)} at a corner"


def _on_single_uv_side(uvs: np.ndarray) -> tuple[int, float] | None:
    """The (coordinate, constant value) of the square side all points share, or None."""
    for coord in (0, 1):
        for value in (0.0, 1.0):
            if np.all(uvs[:, coord] == value):
                return coord, value
    return None


def test_blob_shared_polyline_is_exactly_one_uv_side_in_both_charts() -> None:
    # The watertight-by-construction property U7.2 depends on: each shared polyline
    # maps onto exactly ONE uv side of BOTH incident charts — its two junction
    # endpoints are two adjacent uv corners and its interior vertices lie on that
    # constant-u-or-v = 0/1 side. This is what makes fit_scattered's whole-side rim
    # pinning (u0/u1/v0/v1) airtight.
    mesh = _blob()
    result = cube_map_charts(mesh)
    for polyline in result.polylines:
        assert not polyline.is_loop  # blob is the 4-regular cube graph
        for chart_id in polyline.charts:
            chart = result.charts[chart_id]
            locals_ = np.searchsorted(chart.vertex_map, np.asarray(polyline.vertices))
            assert np.array_equal(chart.vertex_map[locals_], np.asarray(polyline.vertices))
            uvs = chart.uv[locals_]
            side = _on_single_uv_side(uvs)
            assert side is not None, (
                f"polyline {polyline.vertices} not on one uv side of chart {chart_id}: {uvs}"
            )
            # Endpoints are two distinct, adjacent square corners bounding that side.
            for endpoint_uv in (tuple(uvs[0]), tuple(uvs[-1])):
                assert endpoint_uv in SQUARE_CORNERS, f"endpoint {endpoint_uv} not a corner"
            assert tuple(uvs[0]) != tuple(uvs[-1]), "polyline endpoints coincide"


# --- harmonic_disk_map_pinned: contract + validation --------------------------------------


def _grid_disk() -> trimesh.Trimesh:
    """3x3 vertex grid → 8 triangles: an 8-vertex boundary loop with one interior vertex."""
    coords = [0.0, 1.0, 2.0]
    verts = np.array([[x, y, 0.0] for y in coords for x in coords], dtype=np.float64)
    faces = []
    for row in range(2):
        for col in range(2):
            a = row * 3 + col
            faces += [[a, a + 1, a + 4], [a, a + 4, a + 3]]
    return trimesh.Trimesh(vertices=verts, faces=np.array(faces), process=False)


def _oriented_loop(mesh: trimesh.Trimesh) -> list[int]:
    return [int(v) for v in _orient_to_face_winding(np.asarray(mesh.faces), boundary_loops(mesh)[0])]


def test_harmonic_disk_map_pinned_places_given_corners_and_is_flip_free() -> None:
    mesh = _grid_disk()
    loop = _oriented_loop(mesh)
    step = len(loop) // 4
    corners = [loop[0], loop[step], loop[2 * step], loop[3 * step]]  # in loop order
    uv = harmonic_disk_map_pinned(mesh, corners)
    assert uv.shape == (len(mesh.vertices), 2)
    assert flipped_uv_triangles(mesh, uv).size == 0
    assert {tuple(uv[c]) for c in corners} == SQUARE_CORNERS
    # Interior vertex (not on the boundary loop) is strictly inside the unit square.
    interior = [v for v in range(len(mesh.vertices)) if v not in loop]
    for v in interior:
        assert np.all(uv[v] > 0.0) and np.all(uv[v] < 1.0)


def test_harmonic_disk_map_pinned_bitwise_deterministic() -> None:
    mesh = _grid_disk()
    loop = _oriented_loop(mesh)
    step = len(loop) // 4
    corners = [loop[0], loop[step], loop[2 * step], loop[3 * step]]
    assert harmonic_disk_map_pinned(mesh, corners).tobytes() == (
        harmonic_disk_map_pinned(mesh, corners).tobytes()
    )


def test_harmonic_disk_map_pinned_rejects_wrong_corner_count() -> None:
    mesh = _grid_disk()
    loop = _oriented_loop(mesh)
    with pytest.raises(ValueError, match="4 corner"):
        harmonic_disk_map_pinned(mesh, loop[:3])


def test_harmonic_disk_map_pinned_rejects_non_boundary_corner() -> None:
    mesh = _grid_disk()
    loop = _oriented_loop(mesh)
    interior = next(v for v in range(len(mesh.vertices)) if v not in loop)
    step = len(loop) // 4
    corners = [loop[0], loop[step], loop[2 * step], interior]
    with pytest.raises(ValueError, match="boundary loop"):
        harmonic_disk_map_pinned(mesh, corners)


def test_harmonic_disk_map_pinned_rejects_out_of_order_corners() -> None:
    mesh = _grid_disk()
    loop = _oriented_loop(mesh)
    step = len(loop) // 4
    # Swap two corners so they are no longer in boundary-loop order.
    corners = [loop[0], loop[2 * step], loop[step], loop[3 * step]]
    with pytest.raises(ValueError, match="boundary-loop order"):
        harmonic_disk_map_pinned(mesh, corners)


def test_chart_corner_locals_rejects_non_4_valent_chart() -> None:
    # A chart whose boundary carries != 4 junctions cannot map to a 4-corner square;
    # the guard raises UnsupportedTopologyError so the pipeline falls back to faceted
    # (FR-5). Simulated by handing _chart_corner_locals a junction set that meets the
    # grid-disk boundary in 3 (not 4) vertices.
    mesh = _grid_disk()
    vertex_map = np.arange(len(mesh.vertices), dtype=np.int64)
    loop = _oriented_loop(mesh)
    three_junctions = set(loop[:3])
    with pytest.raises(UnsupportedTopologyError, match="4-valent"):
        _chart_corner_locals(mesh, vertex_map, three_junctions)


# --- determinism ---------------------------------------------------------------------------


def test_blob_cube_map_charts_bitwise_deterministic() -> None:
    first = cube_map_charts(_blob())
    second = cube_map_charts(_blob())
    assert first.polylines == second.polylines
    for chart_a, chart_b in zip(first.charts, second.charts):
        assert chart_a.direction == chart_b.direction
        assert chart_a.faces.tobytes() == chart_b.faces.tobytes()
        assert chart_a.vertex_map.tobytes() == chart_b.vertex_map.tobytes()
        assert chart_a.uv.tobytes() == chart_b.uv.tobytes()
        assert chart_a.boundary == chart_b.boundary


# --- inline cube: the ideal partition is exact ----------------------------------------------


def test_cube_partition_matches_the_six_sides_exactly() -> None:
    mesh = _cube()
    result = cube_map_charts(mesh)
    for chart_id, chart in enumerate(result.charts):
        assert chart.faces.tolist() == [2 * chart_id, 2 * chart_id + 1], (
            f"chart {chart_id} is not exactly its cube side"
        )


def test_cube_polylines_are_the_twelve_cube_edges() -> None:
    mesh = _cube()
    result = cube_map_charts(mesh)
    assert len(result.polylines) == 12
    seen = {}
    for polyline in result.polylines:
        assert not polyline.is_loop
        assert len(polyline.vertices) == 2
        edge = frozenset(polyline.vertices)
        assert edge in CUBE_EDGE_CHARTS, f"{tuple(polyline.vertices)} is not a cube edge"
        assert polyline.charts == tuple(sorted(CUBE_EDGE_CHARTS[edge]))
        seen[edge] = polyline
    assert len(seen) == 12
    # All 8 cube corners are junction vertices (3 charts each).
    incident = _vertex_charts(mesh, result)
    assert all(len(incident[v]) == 3 for v in range(8))


def test_cube_chart_uv_hits_the_four_square_corners() -> None:
    mesh = _cube()
    result = cube_map_charts(mesh)
    corners = {(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)}
    for chart_id, chart in enumerate(result.charts):
        sub = _submesh(mesh, chart)
        assert flipped_uv_triangles(sub, chart.uv).size == 0
        assert {tuple(row) for row in chart.uv} == corners, f"chart {chart_id}: {chart.uv}"


# --- error case: not a closed genus-0 mesh ---------------------------------------------------


def test_open_mesh_rejected_with_clear_error() -> None:
    with pytest.raises(ValueError, match="closed"):
        cube_map_charts(_dome())
