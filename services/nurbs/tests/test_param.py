"""U4.2 — harmonic disk parameterization to the unit square (SPEC-12 §5.2 `param.py`).

Conventions under test (U7.1's cube-map charts reuse them):
- boundary loop mapped to the unit-square perimeter by cumulative chord length,
  corners at cumulative arc lengths {0, L/4, L/2, 3L/4};
- perimeter walk starts at the loop's deterministic first vertex (meshio's
  smallest-index start) and lands on corner (0, 0);
- uv boundary is counter-clockwise (loop reversed if needed to match the mesh's
  face winding), so all uv triangle signed areas are positive — no flips;
- fully deterministic: two runs are bitwise identical, no RNG anywhere.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import trimesh

from app.meshio import boundary_loops, load_mesh
from app.param import flipped_uv_triangles, harmonic_disk_map

FIXTURES = Path(__file__).resolve().parent / "fixtures"

CORNERS = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))


def _dome() -> trimesh.Trimesh:
    return load_mesh((FIXTURES / "dome.glb").read_bytes())


def _grid(n: int = 6, h: float = 0.7, origin: tuple[float, float, float] = (2.0, -1.0, 0.5)) -> trimesh.Trimesh:
    """Regular n x n planar grid (row-major vertices), consistently CCW faces (+z normals)."""
    ox, oy, oz = origin
    xs = ox + h * np.arange(n)
    ys = oy + h * np.arange(n)
    vertices = np.array([[x, y, oz] for y in ys for x in xs])  # index = j*n + i
    faces = []
    for j in range(n - 1):
        for i in range(n - 1):
            v00 = j * n + i
            v10 = v00 + 1
            v01 = v00 + n
            v11 = v01 + 1
            faces.append([v00, v10, v11])
            faces.append([v00, v11, v01])
    return trimesh.Trimesh(vertices=vertices, faces=np.array(faces), process=False)


def _tetrahedron() -> trimesh.Trimesh:
    """Tiny closed mesh (no boundary loop at all)."""
    vertices = np.array(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    )
    faces = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _perimeter_position(u: float, v: float) -> float:
    """Arc-length-style coordinate in [0, 4) along the CCW unit-square perimeter.

    Raises AssertionError if (u, v) is not on the perimeter within 1e-12.
    """
    tol = 1e-12
    if abs(v) <= tol and u <= 1.0 - tol:
        return u
    if abs(u - 1.0) <= tol and v <= 1.0 - tol:
        return 1.0 + v
    if abs(v - 1.0) <= tol and u >= tol:
        return 2.0 + (1.0 - u)
    if abs(u) <= tol and v >= tol:
        return 3.0 + (1.0 - v)
    raise AssertionError(f"({u}, {v}) is not on the unit-square perimeter (1e-12)")


def _uv_signed_areas(mesh: trimesh.Trimesh, uv: np.ndarray) -> np.ndarray:
    tri = uv[mesh.faces]
    e1 = tri[:, 1] - tri[:, 0]
    e2 = tri[:, 2] - tri[:, 0]
    return 0.5 * (e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])


# --- dome.glb: the open-mode fixture --------------------------------------------------


def test_dome_uv_shape_and_dtype() -> None:
    mesh = _dome()
    uv = harmonic_disk_map(mesh)
    assert uv.shape == (len(mesh.vertices), 2)
    assert uv.dtype == np.float64
    assert np.isfinite(uv).all()


def test_dome_boundary_lands_exactly_on_square_perimeter() -> None:
    mesh = _dome()
    uv = harmonic_disk_map(mesh)
    loop = boundary_loops(mesh)[0]
    for vertex in loop:
        u, v = uv[vertex]
        # On one of the four edges within 1e-12 (raises otherwise) and inside [0, 1].
        _perimeter_position(u, v)
        assert -1e-12 <= u <= 1.0 + 1e-12
        assert -1e-12 <= v <= 1.0 + 1e-12


def test_dome_boundary_progresses_monotonically_around_perimeter() -> None:
    mesh = _dome()
    uv = harmonic_disk_map(mesh)
    loop = boundary_loops(mesh)[0]
    positions = np.array([_perimeter_position(*uv[vertex]) for vertex in loop])
    # The walk starts at the loop's deterministic first vertex, pinned to corner (0, 0).
    assert positions[0] == 0.0
    # Monotone traversal: strictly increasing in meshio's loop order, or strictly
    # decreasing if param reversed the loop to make the uv boundary counter-clockwise.
    steps = np.diff(positions[1:])
    assert np.all(steps > 0.0) or np.all(steps < 0.0)
    assert len(np.unique(positions)) == len(positions)


def test_dome_hits_all_four_corners_exactly() -> None:
    mesh = _dome()
    uv = harmonic_disk_map(mesh)
    boundary_uv = uv[boundary_loops(mesh)[0]]
    for corner in CORNERS:
        assert np.any((boundary_uv == np.array(corner)).all(axis=1)), f"corner {corner} not hit"


def test_dome_interior_strictly_inside_unit_square() -> None:
    mesh = _dome()
    uv = harmonic_disk_map(mesh)
    interior = np.setdiff1d(np.arange(len(mesh.vertices)), np.array(boundary_loops(mesh)[0]))
    assert interior.size > 0  # the fixture genuinely exercises the sparse solve
    assert np.all(uv[interior, 0] > 0.0) and np.all(uv[interior, 0] < 1.0)
    assert np.all(uv[interior, 1] > 0.0) and np.all(uv[interior, 1] < 1.0)


def test_dome_has_no_flipped_uv_triangles() -> None:
    mesh = _dome()
    uv = harmonic_disk_map(mesh)
    flipped = flipped_uv_triangles(mesh, uv)
    assert isinstance(flipped, np.ndarray)
    assert flipped.size == 0
    # Orientation convention: face windings stay positively oriented in uv (CCW boundary).
    assert np.all(_uv_signed_areas(mesh, uv) > 0.0)


def test_dome_map_is_bitwise_deterministic() -> None:
    first = harmonic_disk_map(_dome())
    second = harmonic_disk_map(_dome())
    assert first.tobytes() == second.tobytes()


# --- analytic planar patch: harmonic map must reproduce the grid itself ---------------


def test_planar_grid_reproduces_its_own_normalized_coordinates() -> None:
    n, h = 6, 0.7
    mesh = _grid(n=n, h=h)
    uv = harmonic_disk_map(mesh)
    span = h * (n - 1)
    expected = np.column_stack(
        [(mesh.vertices[:, 0] - 2.0) / span, (mesh.vertices[:, 1] + 1.0) / span]
    )
    # Planar convex case: chord-length boundary = the grid's own edges, and the cotangent
    # Laplacian reproduces linear functions exactly, so uv == affine-normalized grid.
    assert np.allclose(uv, expected, rtol=0.0, atol=1e-8)
    assert flipped_uv_triangles(mesh, uv).size == 0


# --- error case: not a disk ------------------------------------------------------------


def test_closed_mesh_rejected_with_clear_boundary_loop_error() -> None:
    with pytest.raises(ValueError, match="exactly one boundary loop"):
        harmonic_disk_map(_tetrahedron())


# --- flipped_uv_triangles quality check ------------------------------------------------


def test_flipped_uv_triangles_flags_majority_minority_flip() -> None:
    # Two CCW triangles sharing an edge; fold the second one over the shared edge so its
    # uv signed area is negative while the majority stays positive.
    mesh = trimesh.Trimesh(
        vertices=np.array(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]]
        ),
        faces=np.array([[0, 1, 2], [1, 3, 2], [0, 1, 3]]),
        process=False,
    )
    uv = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [0.25, 0.25]])
    flipped = flipped_uv_triangles(mesh, uv)
    assert flipped.tolist() == [1]  # face 1 is folded (negative area vs positive majority)


def test_flipped_uv_triangles_zero_area_counts_as_flipped() -> None:
    mesh = trimesh.Trimesh(
        vertices=np.array(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]]
        ),
        faces=np.array([[0, 1, 2], [1, 3, 2]]),
        process=False,
    )
    uv = np.array([[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]])  # collinear: face 0 degenerate
    flipped = flipped_uv_triangles(mesh, uv)
    assert 0 in flipped.tolist()
