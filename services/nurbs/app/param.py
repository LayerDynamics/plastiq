"""Mesh uv-parameterization: harmonic disk map + cube-map charts (SPEC-12 §5.2 `param.py`).

Parameterization front half of the fitting pipeline (§5.1). Open mode: a disk-topology
triangle mesh is flattened to uv coordinates in [0, 1]^2 so the LSQ/refinement stages
can fit a tensor-product surface over it. Closed mode (FR-4): :func:`cube_map_charts`
partitions a closed genus-0 mesh into 6 disk-topology charts by dominant face normal,
extracts the shared boundary polylines between adjacent charts (stored ONCE, referenced
by both charts — the watertight-by-construction mechanism, R-1), and runs a harmonic
disk map per chart with the four square corners pinned at the chart's four junction
vertices (:func:`harmonic_disk_map_pinned`, so each shared polyline lands on exactly one
uv side). This is a parameterization *boundary* module — numpy + scipy.sparse, not MLX
core — and, like everything in the service, has no RNG (NFR-1).

Conventions (the cube-map charts reuse these per chart):

- **Boundary**: the mesh's single boundary loop (``meshio.boundary_loops``) is mapped to
  the unit-square perimeter by cumulative 3D chord length. In OPEN mode, with total loop
  length ``L``, the four square corners sit at the boundary vertices nearest cumulative
  arc lengths ``{0, L/4, L/2, 3L/4}`` (ties broken by earliest traversal position via
  ``argmin``); the perimeter walk starts at the loop's deterministic first vertex (meshio
  starts each loop at its smallest vertex index), always pinned to corner (0, 0). In
  CLOSED mode the four corners are instead pinned to the chart's four junction vertices
  (:func:`harmonic_disk_map_pinned`). Either way, vertices between consecutive corners
  spread along that square edge proportionally to chord length, with the edge's constant
  coordinate set exactly (0.0 or 1.0).

- **Orientation**: the square perimeter is walked counter-clockwise
  (0,0) -> (1,0) -> (1,1) -> (0,1). The loop is traversed in the mesh's *face-winding*
  direction — if meshio's loop runs against the directed boundary edge of its owning
  face, the loop tail is reversed (start vertex kept). Since the sum of the uv faces'
  signed areas equals the signed area of the uv boundary polygon (+1 for the CCW
  square), and the embedding is bijective (below), every uv triangle then has strictly
  positive signed area — the no-flip guarantee that :func:`flipped_uv_triangles` checks.

- **Interior**: discrete harmonic (Dirichlet) with cotangent Laplacian weights
  ``w_ij = cot(alpha_ij) + cot(beta_ij)`` over the two triangles sharing edge ``ij``.
  Negative cotangent weights are CLAMPED to 0 and a tiny epsilon (1e-12) is added to
  every mesh edge to keep the weight graph irreducible: with a convex (square) boundary
  and strictly positive convex-combination weights, Tutte's/Floater's theorem guarantees
  the piecewise-linear map is a bijective embedding — clamping trades a little metric
  fidelity on obtuse meshes for that hard no-fold guarantee. The two Dirichlet systems
  (u and v right-hand sides) are solved on the interior x interior block with
  ``scipy.sparse.linalg.spsolve`` — fully deterministic, bitwise reproducible.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp
import trimesh
from scipy.sparse.linalg import spsolve

from .meshio import UnsupportedTopologyError, analyze, boundary_loops

# Square corners in counter-clockwise perimeter order. Open mode places corner k at
# cumulative boundary arc length k * L / 4; closed mode pins them at chart junctions.
_SQUARE_CORNERS = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))

_WEIGHT_EPSILON = 1e-12


def harmonic_disk_map(mesh) -> np.ndarray:
    """Harmonically map a disk-topology mesh to the unit square [0, 1]^2.

    Returns a ``(n_vertices, 2)`` float64 uv array. Boundary vertices land exactly on
    the square perimeter (corner placement + orientation conventions in the module
    docstring); interior vertices are strictly inside (0, 1)^2 with no flipped
    triangles. Deterministic: identical input gives bitwise-identical output.

    Raises ``ValueError`` if the mesh does not have exactly one boundary loop, or if
    the loop is too small/degenerate to pin four distinct corners.
    """
    loops = boundary_loops(mesh)
    if len(loops) != 1:
        raise ValueError(
            f"harmonic disk map needs exactly one boundary loop (disk topology), "
            f"found {len(loops)}"
        )
    loop = _orient_to_face_winding(np.asarray(mesh.faces, dtype=np.int64), loops[0])

    n_vertices = len(mesh.vertices)
    uv = np.zeros((n_vertices, 2), dtype=np.float64)
    uv[loop] = _square_boundary_uv(np.asarray(mesh.vertices, dtype=np.float64)[loop])
    return _solve_interior_dirichlet(mesh, loop, uv)


def harmonic_disk_map_pinned(mesh, corner_local_vertices) -> np.ndarray:
    """Harmonic disk map with four *given* boundary vertices pinned to the square corners.

    Closed-mode variant of :func:`harmonic_disk_map` (FR-4): instead of placing the four
    square corners at the boundary's quarter-arc lengths, ``corner_local_vertices`` names
    the four (local) boundary vertices to pin to (0,0) -> (1,0) -> (1,1) -> (0,1), in
    boundary-loop (face-winding) order. The boundary *between* consecutive corners is
    mapped onto each square side by arc length, and the interior is filled with the SAME
    cotangent-Laplacian Dirichlet solve. This lets each shared chart polyline (a
    junction-to-junction arc) land on exactly one uv side — the watertight-by-construction
    requirement (module docstring of :func:`cube_map_charts`). Deterministic and, like
    the open map, flip-free for a valid disk (Tutte/Floater with a convex boundary).

    Args:
        mesh: a disk-topology (single boundary loop) triangle mesh — a cube-map chart.
        corner_local_vertices: exactly four DISTINCT boundary-loop vertices (local
            indices) in boundary-loop order — the chart's four junction vertices.

    Raises ``ValueError`` if the mesh does not have exactly one boundary loop, if fewer
    or more than four corners are given, if a corner is not on the boundary loop, or if
    the four corners are not distinct and in boundary-loop order.
    """
    loops = boundary_loops(mesh)
    if len(loops) != 1:
        raise ValueError(
            f"harmonic disk map (pinned) needs exactly one boundary loop (disk "
            f"topology), found {len(loops)}"
        )
    loop = _orient_to_face_winding(np.asarray(mesh.faces, dtype=np.int64), loops[0])

    corners = [int(c) for c in corner_local_vertices]
    if len(corners) != 4:
        raise ValueError(
            f"harmonic disk map (pinned) needs exactly 4 corner vertices (got {len(corners)})"
        )
    loop_index = {int(v): i for i, v in enumerate(loop)}
    for corner in corners:
        if corner not in loop_index:
            raise ValueError(f"pinned corner vertex {corner} is not on the boundary loop")
    positions = [loop_index[c] for c in corners]
    n_loop = len(loop)
    offsets = [(p - positions[0]) % n_loop for p in positions]
    if len(set(offsets)) != 4 or offsets != sorted(offsets):
        raise ValueError(
            "pinned corner vertices must be given in boundary-loop order "
            "(distinct and in cyclic loop order — monotonically ordered around "
            "the boundary loop)"
        )

    # Rotate the loop so the first corner sits at position 0, matching the arc-length
    # mapping's assumption (first corner == loop start); uv is written per vertex id.
    rotation = positions[0]
    rotated_loop = np.concatenate([loop[rotation:], loop[:rotation]])

    n_vertices = len(mesh.vertices)
    uv = np.zeros((n_vertices, 2), dtype=np.float64)
    boundary_points = np.asarray(mesh.vertices, dtype=np.float64)[rotated_loop]
    uv[rotated_loop] = _map_boundary_to_square(boundary_points, offsets)
    return _solve_interior_dirichlet(mesh, loop, uv)


def _solve_interior_dirichlet(mesh, loop: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """Fill interior uv by the cotangent-Laplacian Dirichlet solve (boundary uv preset).

    ``loop`` holds the boundary vertex indices (already assigned in ``uv``); the two
    interior systems (u and v right-hand sides) are solved on the interior x interior
    block with ``scipy.sparse.linalg.spsolve`` — the shared, bitwise-deterministic core
    of both :func:`harmonic_disk_map` (open) and :func:`harmonic_disk_map_pinned` (closed).
    """
    n_vertices = len(mesh.vertices)
    interior = np.setdiff1d(np.arange(n_vertices), loop)
    if interior.size:
        weights = _cotangent_weights(mesh)
        laplacian = sp.diags(np.asarray(weights.sum(axis=1)).ravel()) - weights
        system = laplacian.tocsr()[interior][:, interior].tocsc()
        rhs = weights.tocsr()[interior][:, loop] @ uv[loop]
        uv[interior, 0] = spsolve(system, rhs[:, 0])
        uv[interior, 1] = spsolve(system, rhs[:, 1])
    return uv


def flipped_uv_triangles(mesh, uv: np.ndarray) -> np.ndarray:
    """Indices of faces whose uv signed area is <= 0 against the majority orientation.

    The majority sign of the faces' uv signed areas fixes the map's orientation
    (ties fall back to counter-clockwise); any face whose signed area is zero or of
    the opposite sign is folded/degenerate. An empty result is the pipeline's
    no-flip quality gate for a parameterization.
    """
    triangles = np.asarray(uv, dtype=np.float64)[np.asarray(mesh.faces, dtype=np.int64)]
    edge_a = triangles[:, 1] - triangles[:, 0]
    edge_b = triangles[:, 2] - triangles[:, 0]
    signed_areas = 0.5 * (edge_a[:, 0] * edge_b[:, 1] - edge_a[:, 1] * edge_b[:, 0])
    majority = 1.0 if (signed_areas > 0.0).sum() >= (signed_areas < 0.0).sum() else -1.0
    return np.flatnonzero(majority * signed_areas <= 0.0)


def _orient_to_face_winding(faces: np.ndarray, loop: list[int]) -> np.ndarray:
    """Return the loop traversed in face-winding direction, keeping its start vertex.

    A boundary edge belongs to exactly one face; walking the loop along that face's
    directed edge keeps the surface on the left, so the loop is counter-clockwise with
    respect to the faces' orientation. Mapping it onto the CCW square perimeter then
    makes every uv face positively oriented (module docstring). meshio's traversal
    (smaller-indexed neighbour first) is direction-agnostic, so reverse the tail when
    the first loop edge runs against its face.
    """
    if len(loop) < 4:
        raise ValueError(
            f"boundary loop has only {len(loop)} vertices — need at least 4 to pin the "
            f"square corners"
        )
    directed_edges = {
        (int(a), int(b))
        for corner in range(3)
        for a, b in faces[:, [corner, (corner + 1) % 3]]
    }
    first, second = loop[0], loop[1]
    if (first, second) in directed_edges:
        return np.asarray(loop, dtype=np.int64)
    if (second, first) in directed_edges:
        return np.asarray([loop[0], *loop[:0:-1]], dtype=np.int64)
    raise ValueError(f"boundary edge ({first}, {second}) not found in any face winding")


def _boundary_arc_lengths(points: np.ndarray) -> tuple[np.ndarray, float]:
    """Cumulative arc length per vertex and total loop length for a closed polyline.

    Raises ``ValueError`` on a zero-length boundary edge (a degenerate loop).
    """
    closed = np.vstack([points, points[:1]])
    chord = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    if np.any(chord <= 0.0):
        raise ValueError("degenerate boundary loop: zero-length boundary edge")
    total = float(chord.sum())
    arc = np.concatenate([[0.0], np.cumsum(chord[:-1])])  # cumulative arc per vertex
    return arc, total


def _square_boundary_uv(points: np.ndarray) -> np.ndarray:
    """Open-mode chord-length uv: square corners at the boundary's quarter-arc lengths.

    Places the four square corners at the boundary vertices nearest cumulative arc
    lengths ``{0, L/4, L/2, 3L/4}`` (module docstring), then maps the perimeter by arc
    length via :func:`_map_boundary_to_square`. This is the U4.2 open-mode placement and
    is deliberately left unchanged; closed mode pins corners at chart junctions instead
    (see :func:`harmonic_disk_map_pinned`).
    """
    arc, total = _boundary_arc_lengths(points)
    corner_targets = total * np.arange(4) / 4.0
    corner_positions = np.array(
        [int(np.argmin(np.abs(arc - target))) for target in corner_targets]
    )
    if len(np.unique(corner_positions)) != 4 or np.any(np.diff(corner_positions) <= 0):
        raise ValueError(
            "degenerate boundary loop: could not pin four distinct square corners "
            f"(corner vertices at loop positions {corner_positions.tolist()})"
        )
    return _map_boundary_to_square(points, corner_positions)


def _map_boundary_to_square(points: np.ndarray, corner_positions) -> np.ndarray:
    """Map an oriented boundary polyline onto the CCW square by arc length between corners.

    ``corner_positions`` are the four loop indices pinned to the square corners in
    perimeter order (0,0) -> (1,0) -> (1,1) -> (0,1); they must be strictly increasing
    with the first at the loop start (position 0). Each vertex between two consecutive
    corners spreads along that square side proportionally to chord length (``t = 0``
    exactly at the corner), with the side's constant coordinate written exactly
    (0.0 / 1.0). Shared by :func:`_square_boundary_uv` (open, quarter-arc corners) and
    :func:`harmonic_disk_map_pinned` (closed, corners at chart junctions).
    """
    arc, total = _boundary_arc_lengths(points)
    uv = np.empty((len(points), 2), dtype=np.float64)
    for side in range(4):
        start = corner_positions[side]
        if side < 3:
            stop, stop_arc = corner_positions[side + 1], arc[corner_positions[side + 1]]
            span = np.arange(start, stop)
        else:
            stop_arc = total  # wrap back to the loop start (corner 0)
            span = np.arange(start, len(points))
        # Fraction of the way along this square side, by chord length; t = 0 exactly at
        # the corner. The side's constant coordinate is written exactly (0.0 / 1.0).
        t = (arc[span] - arc[start]) / (stop_arc - arc[start])
        if side == 0:  # bottom: (0,0) -> (1,0)
            uv[span, 0], uv[span, 1] = t, 0.0
        elif side == 1:  # right: (1,0) -> (1,1)
            uv[span, 0], uv[span, 1] = 1.0, t
        elif side == 2:  # top: (1,1) -> (0,1)
            uv[span, 0], uv[span, 1] = 1.0 - t, 1.0
        else:  # left: (0,1) -> (0,0)
            uv[span, 0], uv[span, 1] = 0.0, 1.0 - t
    for side, position in enumerate(corner_positions):
        uv[position] = _SQUARE_CORNERS[side]
    return uv


def _cotangent_weights(mesh) -> sp.csr_matrix:
    """Symmetric cotangent edge-weight matrix, clamped to be non-negative.

    ``w_ij = cot(alpha_ij) + cot(beta_ij)`` over the triangle corners opposite edge
    ``ij``. Negative cotangents (obtuse angles) are clamped to 0 and every mesh edge
    gets ``_WEIGHT_EPSILON`` so the graph stays irreducible — the strictly positive
    convex-combination weights Tutte's/Floater's bijectivity theorem needs.
    """
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)

    rows, cols, values = [], [], []
    for corner in range(3):
        opposite = faces[:, corner]
        edge_i = faces[:, (corner + 1) % 3]
        edge_j = faces[:, (corner + 2) % 3]
        toward_i = vertices[edge_i] - vertices[opposite]
        toward_j = vertices[edge_j] - vertices[opposite]
        cross = np.linalg.norm(np.cross(toward_i, toward_j), axis=1)
        dot = np.einsum("ij,ij->i", toward_i, toward_j)
        cotangent = dot / np.maximum(cross, np.finfo(np.float64).tiny)
        clamped = np.maximum(cotangent, 0.0)  # clamp negative cotangents to 0
        rows.extend([edge_i, edge_j])
        cols.extend([edge_j, edge_i])
        values.extend([clamped, clamped])

    # Epsilon on every mesh edge (both directions) keeps the matrix irreducible even
    # where clamping zeroed a weight.
    edges = np.asarray(mesh.edges_unique, dtype=np.int64)
    epsilon = np.full(len(edges), _WEIGHT_EPSILON)
    rows.extend([edges[:, 0], edges[:, 1]])
    cols.extend([edges[:, 1], edges[:, 0]])
    values.extend([epsilon, epsilon])

    n_vertices = len(vertices)
    weights = sp.coo_matrix(
        (np.concatenate(values), (np.concatenate(rows), np.concatenate(cols))),
        shape=(n_vertices, n_vertices),
    )
    return weights.tocsr()


# --- closed mode: cube-map 6-chart layout + shared boundary polylines (U7.1, FR-4) -----

# Fixed direction order; chart index == direction index, argmax ties -> lowest index.
_CUBE_DIRECTIONS = np.array(
    [
        [1.0, 0.0, 0.0],   # 0: +x
        [-1.0, 0.0, 0.0],  # 1: -x
        [0.0, 1.0, 0.0],   # 2: +y
        [0.0, -1.0, 0.0],  # 3: -y
        [0.0, 0.0, 1.0],   # 4: +z
        [0.0, 0.0, -1.0],  # 5: -z
    ]
)

_REPAIR_MAX_ITERATIONS = 32


@dataclass(frozen=True)
class SharedPolyline:
    """One shared boundary polyline between two adjacent charts, stored ONCE.

    ``vertices`` is the ordered global vertex-index path. Open polylines run between
    junction vertices (where >= 3 charts meet), both endpoints included; ``is_loop``
    polylines are closed cycles between exactly 2 charts (no repeated end vertex).
    Both charts of ``charts`` (a sorted pair) reference this identical entry from
    :class:`Chart.boundary` with an orientation flag — U7.2 fits each polyline once
    and pins both patches' rims to the same curve (SPEC-12 R-1).
    """

    charts: tuple[int, int]
    vertices: tuple[int, ...]
    is_loop: bool


@dataclass(frozen=True)
class Chart:
    """One of the 6 cube-map charts: a disk-topology submesh with its own uv map.

    - ``direction``: index into ``_CUBE_DIRECTIONS`` (== the chart's index).
    - ``faces``: global face indices, ascending.
    - ``vertex_map``: local -> global vertex indices, ascending (local face indices
      are ``searchsorted(vertex_map, global_faces)``).
    - ``uv``: ``(len(vertex_map), 2)`` :func:`harmonic_disk_map_pinned` of the submesh,
      with the four square corners pinned at the chart's four junction vertices.
    - ``boundary``: ordered ``(polyline index, reversed)`` pairs — traversing each
      referenced :class:`SharedPolyline` (reversed when flagged) chains into the
      chart's boundary loop in face-winding (uv counter-clockwise) direction.
    """

    direction: int
    faces: np.ndarray
    vertex_map: np.ndarray
    uv: np.ndarray
    boundary: tuple[tuple[int, bool], ...]


@dataclass(frozen=True)
class CubeMapCharts:
    """The full closed-mode layout: 6 charts + the shared-polyline table."""

    charts: tuple[Chart, ...]
    polylines: tuple[SharedPolyline, ...]


def cube_map_charts(mesh) -> CubeMapCharts:
    """Partition a closed genus-0 mesh into 6 disk charts with shared boundaries.

    1. Assign each face to the chart whose direction maximizes ``normal . direction``
       (lowest direction index wins ties).
    2. Deterministically repair (:func:`_repair_chart_labels`) until every chart is
       non-empty, edge-connected, disk-topology (one boundary loop, Euler
       characteristic 1) AND flip-free under the quarter-arc :func:`harmonic_disk_map`.
       Raises ``ValueError`` if that does not converge within ``_REPAIR_MAX_ITERATIONS``
       — a non-disk chart is never emitted.
    3. Extract the shared boundary polylines (module docstring of
       :class:`SharedPolyline`), stored once and referenced by both charts.
    4. Map each chart's submesh with :func:`harmonic_disk_map_pinned`, pinning the four
       square corners at the chart's four junction vertices (:func:`_chart_corner_locals`)
       so each shared polyline lands on exactly one uv side (R-1). A chart that is not
       4-valent, or whose emitted pinned map still has a flipped triangle (checked here,
       since the repair gate checks the quarter-arc map, not the pinned one), raises
       :class:`UnsupportedTopologyError` so the pipeline falls back to faceted (FR-5) —
       preserving the "never emit a flipped chart" invariant.

    Deterministic: identical input gives bitwise-identical output (no RNG).
    """
    topology = analyze(mesh)
    if topology.mode != "closed":
        raise ValueError(
            f'cube-map charts need a closed genus-0 mesh, got mode "{topology.mode}" '
            f"({topology.n_boundary_loops} boundary loops)"
        )

    faces = np.asarray(mesh.faces, dtype=np.int64)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    adjacency = np.asarray(mesh.face_adjacency, dtype=np.int64)
    adjacency_edges = np.sort(np.asarray(mesh.face_adjacency_edges, dtype=np.int64), axis=1)
    edge_lengths = np.linalg.norm(
        vertices[adjacency_edges[:, 0]] - vertices[adjacency_edges[:, 1]], axis=1
    )

    normals = np.asarray(mesh.face_normals, dtype=np.float64)
    labels = np.argmax(normals @ _CUBE_DIRECTIONS.T, axis=1).astype(np.int64)
    labels = _repair_chart_labels(labels, adjacency, edge_lengths, faces, vertices)

    junctions = _junction_vertices(faces, labels)
    polylines = _shared_polylines(labels, adjacency, adjacency_edges, junctions)

    charts = []
    for chart_id in range(len(_CUBE_DIRECTIONS)):
        chart_faces = np.flatnonzero(labels == chart_id)
        submesh, vertex_map = _chart_submesh(vertices, faces, chart_faces)
        corner_locals = _chart_corner_locals(submesh, vertex_map, junctions)
        uv = harmonic_disk_map_pinned(submesh, corner_locals)
        if flipped_uv_triangles(submesh, uv).size:
            # The repair gate (_flipped_chart_faces) checks the quarter-arc harmonic map,
            # but the emitted map pins corners at the junctions instead. A boundary "ear"
            # (three consecutive boundary vertices) that lands entirely on one square side
            # — a straight junction-to-junction run — collapses to zero area, because the
            # square is convex but not STRICTLY convex (Tutte's no-flip guarantee needs
            # strict convexity for such a face). It does not occur on the blob gate
            # fixture, but if it ever does, fall back to faceted (FR-5) rather than emit a
            # flipped chart — preserving the "never emit a flipped chart" invariant.
            raise UnsupportedTopologyError(
                f"cube-map chart {chart_id}: junction-pinned uv map has flipped triangles "
                f"(a boundary ear collapses onto one uv side) — falling back to faceted"
            )
        charts.append(
            Chart(
                direction=chart_id,
                faces=chart_faces,
                vertex_map=vertex_map,
                uv=uv,
                boundary=_chart_boundary_refs(submesh, vertex_map, junctions, polylines),
            )
        )
    return CubeMapCharts(charts=tuple(charts), polylines=polylines)


def _chart_corner_locals(
    submesh: trimesh.Trimesh, vertex_map: np.ndarray, junctions: set[int]
) -> list[int]:
    """Local indices of a chart's four junction boundary vertices, in boundary-loop order.

    Walks the chart's boundary loop in face-winding order (the orientation
    :func:`harmonic_disk_map_pinned` maps counter-clockwise onto the square) and collects
    the vertices that are junctions — where >= 3 charts meet, given as global indices in
    ``junctions``. A cube-map chart of a closed genus-0 mesh is 4-valent: exactly four
    junctions bound its four shared polylines, so pinning those four to the square corners
    makes each shared polyline land on exactly one uv side (the watertight-by-construction
    requirement, R-1). Any other junction count cannot map to a 4-corner square, so it
    raises :class:`UnsupportedTopologyError` and the pipeline falls back to faceted faces
    (FR-5).
    """
    loop_local = _orient_to_face_winding(
        np.asarray(submesh.faces, dtype=np.int64), boundary_loops(submesh)[0]
    )
    corner_locals = [int(v) for v in loop_local if int(vertex_map[int(v)]) in junctions]
    if len(corner_locals) != 4:
        raise UnsupportedTopologyError(
            f"cube-map chart is not 4-valent: its boundary meets {len(corner_locals)} "
            f"junction vertices (need exactly 4 to pin the uv-square corners) — falling "
            f"back to faceted"
        )
    return corner_locals


def _chart_submesh(
    vertices: np.ndarray, faces: np.ndarray, chart_faces: np.ndarray
) -> tuple[trimesh.Trimesh, np.ndarray]:
    """Chart submesh with deterministic (ascending) local vertex re-indexing."""
    global_faces = faces[chart_faces]
    vertex_map = np.unique(global_faces)  # sorted ascending -> local order == global order
    local_faces = np.searchsorted(vertex_map, global_faces)
    submesh = trimesh.Trimesh(vertices=vertices[vertex_map], faces=local_faces, process=False)
    return submesh, vertex_map


def _repair_chart_labels(
    labels: np.ndarray,
    adjacency: np.ndarray,
    edge_lengths: np.ndarray,
    faces: np.ndarray,
    vertices: np.ndarray,
) -> np.ndarray:
    """Reassign faces until every chart is a non-empty, flip-free edge-connected disk.

    Three deterministic mechanisms per round, cheapest first:

    1. *Minor components* (the task's core repair): charts 0..5, components by
       (size desc, lowest face index); every component but the largest moves whole
       to the neighbouring chart sharing the longest total 3D boundary length with
       it (ties -> lowest chart index), until no component moves.
    2. *Majority smoothing*: any unclaimed face with >= 2 of its 3 edge-neighbours
       in one other chart moves there. Each move strictly decreases the number of
       cross-chart edges (2 cross edges become interior, <= 1 interior edge becomes
       cross), so smoothing terminates and cannot oscillate. This erases the
       staircase "ears" (a face whose 3 vertices are consecutive chart-boundary
       vertices) that the square-boundary harmonic map degenerates to zero area
       whenever no square corner falls strictly inside their run.
    3. *Junction dissolution*: an ear whose two cross edges lead to two different
       charts survives smoothing — its middle vertex is a junction where >= 3
       charts meet, and single-face moves provably ping-pong (the face is an ear on
       every side). The fix with a guarantee is to make that vertex interior: pull
       every unclaimed face of the vertex's fan into the fan's plurality-owner
       chart (ties -> lowest chart id) and mark the moved faces *claimed*. A
       claimed face resists smoothing and later junction pulls, which curbs the
       tug-of-war a purely unclaimed strategy exhibits — but the claim is NOT
       permanent: component merging (which outranks flip repair) can still move
       the face and clears its claim (``claimed[minor] = -1``). So the claim
       count is not globally monotone and a flipped ear can recur across outer
       rounds; convergence is therefore not proven by a monotone-decrease
       argument (see the closing paragraph). One dissolution per round (first
       flipped face: charts asc, then local face order), re-verifying everything
       in between.

    The disk check runs at each stable point; a defect there cannot self-repair, so
    it raises. Converged means: no component moved, smoothing at fixpoint, no
    defects, no flipped uv faces. Termination is NOT guaranteed by a monotone
    convergence proof (claims can be cleared, above); it rests on the
    ``_REPAIR_MAX_ITERATIONS`` cap as a backstop. The contract is
    correct-or-raise: raises ``ValueError`` on the iteration cap or a
    fully-claimed fan (stall), and only zero-defect, zero-flip disk charts are ever
    emitted — a non-disk chart is never emitted.

    NB: the flip gate here (:func:`_flipped_chart_faces`) checks the quarter-arc
    :func:`harmonic_disk_map`, because intermediate label states are not yet 4-valent
    (so the junction-pinned corners are undefined mid-repair). The map actually EMITTED
    by :func:`cube_map_charts` pins corners at the junctions instead, so it re-checks the
    pinned map's flip-freeness once and falls back to faceted if it differs (FR-5) — this
    repair does not itself guarantee the pinned map is flip-free.
    """
    labels = labels.copy()
    claimed = np.full(len(faces), -1, dtype=np.int64)  # claiming chart id, or -1
    face_neighbours = _face_neighbours(adjacency, len(faces))
    vertex_fans = _vertex_fans(faces)

    # Perf: each outer iteration re-solves all 6 chart submesh harmonic maps from
    # scratch (via _chart_defects + _flipped_chart_faces) — O(iterations x charts)
    # sparse solves, no incremental reuse. On the same axis, _chart_corner_locals,
    # harmonic_disk_map_pinned, and _chart_boundary_refs each independently recompute
    # boundary_loops/_orient_to_face_winding per chart — worth memoizing alongside
    # dirty-chart tracking. Negligible at the gate fixture's 320 faces; worth
    # revisiting for production-size closed meshes.
    for _ in range(_REPAIR_MAX_ITERATIONS):
        _components_to_fixpoint(labels, adjacency, edge_lengths, claimed)
        _majority_smoothing(labels, face_neighbours, claimed)
        _components_to_fixpoint(labels, adjacency, edge_lengths, claimed)
        defects = _chart_defects(labels, faces, vertices)
        if defects:
            raise ValueError("cube-map chart repair cannot converge: " + "; ".join(defects))
        flipped = _flipped_chart_faces(labels, faces, vertices)
        if not flipped:
            return labels
        _dissolve_junction(flipped[0], labels, faces, face_neighbours, vertex_fans, claimed)
    raise ValueError(
        f"cube-map chart repair did not converge within {_REPAIR_MAX_ITERATIONS} iterations"
    )


def _face_neighbours(adjacency: np.ndarray, n_faces: int) -> list[list[int]]:
    """Edge-neighbour faces per face (3 per face on a closed manifold)."""
    neighbours: list[list[int]] = [[] for _ in range(n_faces)]
    for a, b in adjacency:
        neighbours[int(a)].append(int(b))
        neighbours[int(b)].append(int(a))
    return neighbours


def _vertex_fans(faces: np.ndarray) -> dict[int, list[int]]:
    """Incident faces per vertex, in ascending face order."""
    fans: dict[int, list[int]] = {}
    for face_id, face in enumerate(faces):
        for vertex in face:
            fans.setdefault(int(vertex), []).append(face_id)
    return fans


def _components_to_fixpoint(
    labels: np.ndarray, adjacency: np.ndarray, edge_lengths: np.ndarray, claimed: np.ndarray
) -> None:
    """Merge minor components into their longest-boundary neighbours until stable.

    Moving a face clears its claim — topology repair outranks flip repair.
    """
    for _ in range(_REPAIR_MAX_ITERATIONS):
        moved = False
        for chart in range(len(_CUBE_DIRECTIONS)):
            for minor in _edge_connected_components(labels, adjacency, chart)[1:]:
                target = _dominant_neighbour_chart(minor, labels, adjacency, edge_lengths, chart)
                claimed[minor] = -1
                labels[minor] = target
                moved = True
        if not moved:
            return
    raise ValueError(
        f"cube-map chart repair: minor-component merging did not stabilize within "
        f"{_REPAIR_MAX_ITERATIONS} sweeps"
    )


def _majority_smoothing(
    labels: np.ndarray, face_neighbours: list[list[int]], claimed: np.ndarray
) -> None:
    """Move unclaimed faces with >= 2 neighbours in one other chart to that chart.

    Strictly decreases the cross-chart edge count per move, so the fixpoint loop
    terminates without an iteration cap.
    """
    while True:
        any_move = False
        for face in range(len(labels)):
            if claimed[face] >= 0:
                continue
            own = int(labels[face])
            counts: dict[int, int] = {}
            for neighbour in face_neighbours[face]:
                if labels[neighbour] != own:
                    chart = int(labels[neighbour])
                    counts[chart] = counts.get(chart, 0) + 1
            majority = [chart for chart, count in sorted(counts.items()) if count >= 2]
            if majority:
                labels[face] = majority[0]
                any_move = True
        if not any_move:
            return


def _dissolve_junction(
    face: int,
    labels: np.ndarray,
    faces: np.ndarray,
    face_neighbours: list[list[int]],
    vertex_fans: dict[int, list[int]],
    claimed: np.ndarray,
) -> None:
    """Interiorize a flipped ear's degenerate vertex into the fan's plurality chart.

    The vertex is the one shared by the face's cross-chart edges (the ear middle);
    every unclaimed fan face joins the chart already owning the plurality of the
    fan (ties -> lowest chart id) and is claimed by it.
    """
    own = int(labels[face])
    cross_edge_vertices = [
        set(int(v) for v in np.intersect1d(faces[face], faces[neighbour]))
        for neighbour in face_neighbours[face]
        if labels[neighbour] != own
    ]
    if not cross_edge_vertices:
        raise ValueError(
            f"cube-map chart repair: face {face} of chart {own} has a flipped uv "
            f"triangle but no chart-boundary edge to repair along"
        )
    shared = sorted(set.intersection(*cross_edge_vertices)) if len(cross_edge_vertices) > 1 else []
    vertex = shared[0] if shared else sorted(v for s in cross_edge_vertices for v in s)[0]

    fan = vertex_fans[vertex]
    counts: dict[int, int] = {}
    for fan_face in fan:
        chart = int(labels[fan_face])
        counts[chart] = counts.get(chart, 0) + 1
    host = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]
    pull = [fan_face for fan_face in fan if labels[fan_face] != host and claimed[fan_face] < 0]
    if not pull:
        raise ValueError(
            f"cube-map chart repair stalled: the fan of vertex {vertex} (for flipped "
            f"face {face} of chart {own}) is fully claimed"
        )
    for fan_face in pull:
        labels[fan_face] = host
        claimed[fan_face] = host


def _flipped_chart_faces(labels: np.ndarray, faces: np.ndarray, vertices: np.ndarray) -> list[int]:
    """Global face ids whose uv triangle degenerates under their chart's harmonic map.

    Requires every chart to already be a disk (the caller checks defects first).
    Deterministic order: charts ascending, then global face index ascending.
    """
    flipped_faces: list[int] = []
    # Perf: re-solves every chart's harmonic map from scratch each call (see the
    # outer-loop note in _repair_chart_labels) — no incremental reuse.
    for chart in range(len(_CUBE_DIRECTIONS)):
        chart_faces = np.flatnonzero(labels == chart)
        submesh, _ = _chart_submesh(vertices, faces, chart_faces)
        try:
            uv = harmonic_disk_map(submesh)
        except ValueError as exc:
            raise ValueError(
                f"cube-map chart {chart} cannot be harmonically mapped: {exc}"
            ) from exc
        flipped_faces.extend(int(chart_faces[local]) for local in flipped_uv_triangles(submesh, uv))
    return flipped_faces


def _edge_connected_components(
    labels: np.ndarray, adjacency: np.ndarray, chart: int
) -> list[np.ndarray]:
    """Edge-connected face components of one chart, sorted (size desc, min face asc)."""
    chart_faces = np.flatnonzero(labels == chart)
    if chart_faces.size == 0:
        return []
    local = {int(face): i for i, face in enumerate(chart_faces)}
    parent = list(range(len(chart_faces)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in adjacency:
        if labels[a] == chart and labels[b] == chart:
            root_a, root_b = find(local[int(a)]), find(local[int(b)])
            if root_a != root_b:
                parent[max(root_a, root_b)] = min(root_a, root_b)

    groups: dict[int, list[int]] = {}
    for i, face in enumerate(chart_faces):
        groups.setdefault(find(i), []).append(int(face))
    components = sorted(groups.values(), key=lambda g: (-len(g), min(g)))
    return [np.asarray(component, dtype=np.int64) for component in components]


def _dominant_neighbour_chart(
    component: np.ndarray,
    labels: np.ndarray,
    adjacency: np.ndarray,
    edge_lengths: np.ndarray,
    chart: int,
) -> int:
    """Neighbouring chart sharing the longest total boundary with the component."""
    in_component = np.zeros(len(labels), dtype=bool)
    in_component[component] = True
    a, b = adjacency[:, 0], adjacency[:, 1]
    shared = np.zeros(len(_CUBE_DIRECTIONS), dtype=np.float64)
    mask_a = in_component[a] & (labels[b] != chart)
    mask_b = in_component[b] & (labels[a] != chart)
    np.add.at(shared, labels[b][mask_a], edge_lengths[mask_a])
    np.add.at(shared, labels[a][mask_b], edge_lengths[mask_b])
    shared[chart] = -np.inf  # a component never "moves" to its own chart
    target = int(np.argmax(shared))  # ties -> lowest chart index
    if shared[target] <= 0.0:
        raise ValueError(
            f"cube-map chart repair: component of {len(component)} faces in chart {chart} "
            f"has no neighbouring chart to merge into"
        )
    return target


def _chart_defects(labels: np.ndarray, faces: np.ndarray, vertices: np.ndarray) -> list[str]:
    """Human-readable disk-topology violations per chart (empty list == all disks)."""
    defects = []
    # Perf: rebuilds each chart submesh and recomputes its boundary loops + Euler
    # characteristic every call (part of the O(iterations x charts) repair cost noted
    # in _repair_chart_labels) — no incremental reuse.
    for chart in range(len(_CUBE_DIRECTIONS)):
        chart_faces = np.flatnonzero(labels == chart)
        if chart_faces.size == 0:
            defects.append(f"chart {chart} is empty")
            continue
        submesh, _ = _chart_submesh(vertices, faces, chart_faces)
        try:
            loops = boundary_loops(submesh)
        except ValueError as exc:  # non-manifold (pinched) chart boundary
            defects.append(f"chart {chart}: {exc}")
            continue
        euler = len(submesh.vertices) - len(submesh.edges_unique) + len(submesh.faces)
        if len(loops) != 1 or euler != 1:
            defects.append(
                f"chart {chart} is not a disk ({len(loops)} boundary loops, "
                f"Euler characteristic {euler})"
            )
        elif len(loops[0]) < 4:
            # A single-triangle chart passes the disk test (1 loop, Euler 1) but its
            # 3-vertex boundary cannot pin the 4 square corners: _orient_to_face_winding
            # would raise deep inside _flipped_chart_faces this same iteration with a
            # confusing message. Flag it here so repair gets a chance and the message is
            # actionable (matches _orient_to_face_winding's >= 4 requirement).
            defects.append(
                f"chart {chart} boundary loop has only {len(loops[0])} vertices "
                f"(need at least 4 to pin the square corners)"
            )
    return defects


def _junction_vertices(faces: np.ndarray, labels: np.ndarray) -> set[int]:
    """Vertices where >= 3 charts meet — the endpoints of open shared polylines."""
    incident: dict[int, set[int]] = {}
    for face, label in zip(faces, labels):
        for vertex in face:
            incident.setdefault(int(vertex), set()).add(int(label))
    return {vertex for vertex, charts in incident.items() if len(charts) >= 3}


def _edge_key(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def _shared_polylines(
    labels: np.ndarray,
    adjacency: np.ndarray,
    adjacency_edges: np.ndarray,
    junctions: set[int],
) -> tuple[SharedPolyline, ...]:
    """Maximal shared polylines per adjacent chart pair, in deterministic table order.

    For each sorted chart pair the boundary edges form simple paths (endpoints =
    junction vertices, degree 1 in the pair's edge graph) plus closed cycles (no
    junction on them — a loop between exactly 2 charts). Paths are walked from their
    ascending-sorted endpoints, cycles from their smallest vertex toward the
    smaller-indexed neighbour first (meshio's loop convention).
    """
    pair_edges: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for k in range(len(adjacency)):
        label_a, label_b = int(labels[adjacency[k, 0]]), int(labels[adjacency[k, 1]])
        if label_a == label_b:
            continue
        pair = (label_a, label_b) if label_a < label_b else (label_b, label_a)
        u, v = int(adjacency_edges[k, 0]), int(adjacency_edges[k, 1])
        pair_edges.setdefault(pair, []).append((u, v))

    polylines: list[SharedPolyline] = []
    for pair in sorted(pair_edges):
        neighbours: dict[int, list[int]] = {}
        for u, v in sorted(pair_edges[pair]):
            neighbours.setdefault(u, []).append(v)
            neighbours.setdefault(v, []).append(u)
        for vertex, adjacent in neighbours.items():
            if len(adjacent) > 2:
                raise ValueError(
                    f"chart pair {pair}: boundary branches at vertex {vertex} "
                    f"({len(adjacent)} boundary edges) — charts are not disks"
                )
        visited: set[tuple[int, int]] = set()

        def unvisited(vertex: int) -> list[int]:
            return sorted(n for n in neighbours[vertex] if _edge_key(vertex, n) not in visited)

        # Open paths: junction endpoint -> junction endpoint.
        for start in sorted(v for v, adjacent in neighbours.items() if len(adjacent) == 1):
            if not unvisited(start):
                continue  # already consumed as the far end of an earlier path
            path = [start]
            current = start
            while True:
                options = unvisited(current)
                if not options:
                    break
                visited.add(_edge_key(current, options[0]))
                path.append(options[0])
                current = options[0]
            for endpoint in (path[0], path[-1]):
                if endpoint not in junctions:
                    raise ValueError(
                        f"chart pair {pair}: polyline endpoint {endpoint} is not a "
                        f"junction vertex"
                    )
            polylines.append(SharedPolyline(charts=pair, vertices=tuple(path), is_loop=False))

        # Closed loops: whatever edges remain form simple cycles. Defensive/unreachable
        # for the enforced 6 non-empty disk charts — every chart boundary carries >= 1
        # junction, so all edges are consumed as open paths above; kept for a possible
        # future non-cube-map layout (see the is_loop field of SharedPolyline).
        while True:
            remaining = sorted(v for v in neighbours if unvisited(v))
            if not remaining:
                break
            start = remaining[0]
            cycle = [start]
            current = start
            while True:
                options = unvisited(current)
                if not options:
                    break
                visited.add(_edge_key(current, options[0]))
                if options[0] == start:
                    break
                cycle.append(options[0])
                current = options[0]
            polylines.append(SharedPolyline(charts=pair, vertices=tuple(cycle), is_loop=True))
    return tuple(polylines)


def _chart_boundary_refs(
    submesh: trimesh.Trimesh,
    vertex_map: np.ndarray,
    junctions: set[int],
    polylines: tuple[SharedPolyline, ...],
) -> tuple[tuple[int, bool], ...]:
    """Ordered (polyline index, reversed) refs chaining into the chart's boundary loop.

    The loop is oriented in face-winding direction (the same orientation
    :func:`harmonic_disk_map` maps counter-clockwise onto the square), rotated to
    start at its first junction vertex, and split at junction vertices; each segment
    must match one shared polyline forward (``reversed=False``) or backward
    (``reversed=True``). A boundary with no junctions is a single closed polyline.
    """
    loop_local = _orient_to_face_winding(
        np.asarray(submesh.faces, dtype=np.int64), boundary_loops(submesh)[0]
    )
    loop = [int(vertex_map[v]) for v in loop_local]

    junction_positions = [i for i, vertex in enumerate(loop) if vertex in junctions]
    if not junction_positions:
        # A junction-free chart boundary is defensive/unreachable for the 6-chart
        # cube-map layout (every chart boundary carries >= 1 junction); kept for a
        # possible future non-cube-map layout.
        return (_match_loop_polyline(loop, polylines),)

    first = junction_positions[0]
    rotated = loop[first:] + loop[:first]
    positions = [p - first for p in junction_positions]

    lookup: dict[tuple[int, ...], tuple[int, bool]] = {}
    for index, polyline in enumerate(polylines):
        if not polyline.is_loop:
            lookup[polyline.vertices] = (index, False)
            lookup[polyline.vertices[::-1]] = (index, True)

    refs = []
    for k, position in enumerate(positions):
        if k + 1 < len(positions):
            segment = tuple(rotated[position : positions[k + 1] + 1])
        else:
            segment = tuple(rotated[position:] + [rotated[0]])
        if segment not in lookup:
            raise ValueError(
                f"chart boundary segment {segment} matches no shared polyline"
            )
        refs.append(lookup[segment])
    return tuple(refs)


def _match_loop_polyline(
    loop: list[int], polylines: tuple[SharedPolyline, ...]
) -> tuple[int, bool]:
    """Match a junction-free chart boundary to its closed-loop polyline table entry.

    Defensive/unreachable for the 6-chart cube-map layout (every chart boundary
    carries >= 1 junction, so charts always reach _chart_boundary_refs' junction
    split); kept for a possible future non-cube-map layout.
    """
    for index, polyline in enumerate(polylines):
        if not polyline.is_loop or set(polyline.vertices) != set(loop):
            continue
        pivot = loop.index(polyline.vertices[0])
        rotated = loop[pivot:] + loop[:pivot]
        if tuple(rotated) == polyline.vertices:
            return (index, False)
        if tuple([rotated[0]] + rotated[:0:-1]) == polyline.vertices:
            return (index, True)
    raise ValueError(
        f"chart boundary loop of {len(loop)} vertices matches no closed shared polyline"
    )
