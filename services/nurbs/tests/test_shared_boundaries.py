"""U7.2 — shared boundary-curve fitting (SPEC-12 FR-4, R-1): watertight by construction.

The watertightness lever the U7.3 gate rides on. A closed genus-0 mesh is split into 6
cube-map charts (U7.1) sharing boundary polylines; U7.2 fits EACH shared polyline ONCE to
a 1-D clamped B-spline curve (A9.6 endpoint-interpolating LSQ + a small second-difference
fairness term so the system stays SPD even for a 2-vertex — single-edge — polyline, exactly
`fit_scattered`'s regularization rationale), then pins BOTH incident patches' rims to the
SAME fitted control points. Because both patches read one shared-curve table entry and the
`clamped_uniform` knot vector is reflection-symmetric, the two fitted patches reproduce the
IDENTICAL edge curve — watertight by construction, not by sew tolerance (SPEC-7 D-3).

Contracts under test:

- ``fit_boundary_curve``: reproduces a smooth analytic polyline under a deviation bound;
  interpolates the endpoints exactly; is bitwise deterministic (same points ⇒ same control
  points, the shared-edge identity mechanism); uses data-independent ``clamped_uniform``
  knots; and handles a degenerate 2-vertex (straight) segment (the blob/cube have these).
- ``fit_shared_curves`` fits each polyline once into a ``polyline_index → (poles, knots)``
  table; ``pin_chart_rims`` maps a chart's 4 boundary polylines 1:1 onto its 4 uv sides
  (u0/u1/v0/v1), reading the shared curve's control points as the pinned rim values.
- THE property: two adjacent fitted patches, pinned via the shared table, evaluate to the
  same points along the shared edge to ≪ the 1e-6 sew tolerance (blob curved edge + cube
  straight edge); the shared spline space (knots) is bitwise identical between the patches;
  the whole construction is deterministic.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import mlx.core as mx
import numpy as np
import numpy.testing as npt
import pytest
import trimesh

from app.boundary import (
    _classify_uv_side,
    fit_boundary_curve,
    fit_shared_curves,
    pin_chart_rims,
)
from app.core.eval import surface_point
from app.core.fit_lsq import _design_matrix_1d, fit_scattered
from app.core.knots import clamped_uniform
from app.meshio import load_mesh
from app.param import cube_map_charts
from tests.test_param_cubemap import _cube

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# The blob chart-pair the watertightness test rides on: charts 0 (+x) and 2 (+y) share
# polyline 0 — a genuinely CURVED 10-vertex edge, so < 1e-9 coincidence is meaningful and
# not merely a straight line; chart 0 also carries 2-vertex rims, exercising the regularizer
# end-to-end inside pin_chart_rims. The cube's every edge is a 2-vertex (straight) polyline.
_BLOB_PAIR = (0, 2)
_CUBE_PAIR = (0, 2)


def _blob() -> trimesh.Trimesh:
    return load_mesh((FIXTURES / "blob.glb").read_bytes())


def _chord_params(points: np.ndarray) -> np.ndarray:
    """Normalized cumulative chord-length parameters — matches fit_boundary_curve's."""
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    return cum / cum[-1]


def _eval_curve(cp, knots, degree: int, n_ctrl: int, t: np.ndarray) -> np.ndarray:
    """Evaluate the 1-D B-spline curve at ``t`` via the reused design matrix (B @ P)."""
    tm = mx.array(np.asarray(t, dtype=np.float64), dtype=mx.float64)
    km = mx.array(np.asarray(knots, dtype=np.float64), dtype=mx.float64)
    design = np.asarray(_design_matrix_1d(tm, km, degree, n_ctrl), dtype=np.float64)
    return design @ np.asarray(cp, dtype=np.float64)


def _analytic_polyline(n: int = 41) -> np.ndarray:
    """A smooth 3-D polyline a cubic reproduces well (gentle sine/cosine bend)."""
    t = np.linspace(0.0, 1.0, n)
    return np.stack([t, 0.3 * np.sin(np.pi * t), 0.2 * (np.cos(np.pi * t) - 1.0)], axis=1)


def _eval_side(fit, side_key: str, t: np.ndarray) -> np.ndarray:
    """Sample a fitted patch along one of its four uv sides at parameters ``t``."""
    t_np = np.asarray(t, dtype=np.float64)
    tm = mx.array(t_np, dtype=mx.float64)
    zeros = mx.array(np.zeros_like(t_np), dtype=mx.float64)
    ones = mx.array(np.ones_like(t_np), dtype=mx.float64)
    if side_key == "v0":  # v = 0 edge, varies in u
        u, v = tm, zeros
    elif side_key == "v1":  # v = 1 edge
        u, v = tm, ones
    elif side_key == "u0":  # u = 0 edge, varies in v
        u, v = zeros, tm
    elif side_key == "u1":  # u = 1 edge
        u, v = ones, tm
    else:  # pragma: no cover - guard
        raise AssertionError(f"bad side {side_key!r}")
    pts = surface_point(fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q, u, v)
    return np.asarray(pts, dtype=np.float64)


def _shared_polyline_index(charts, a: int, b: int) -> int:
    idxs = [i for i, p in enumerate(charts.polylines) if set(p.charts) == {a, b}]
    assert len(idxs) == 1, f"charts {a},{b} share {len(idxs)} polylines"
    return idxs[0]


def _side_of(chart, poly) -> str:
    locals_ = np.searchsorted(chart.vertex_map, np.asarray(poly.vertices))
    assert np.array_equal(chart.vertex_map[locals_], np.asarray(poly.vertices))
    return _classify_uv_side(chart.uv[locals_])[0]


def _watertight(mesh, a: int, b: int, degree: int, n_ctrl: int):
    """Fit the shared curves, pin both patches, return (coincidence dev, fits, table, idx)."""
    charts = cube_map_charts(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    table = fit_shared_curves(charts, vertices, degree=degree, n_ctrl=n_ctrl)
    chart_a, chart_b = charts.charts[a], charts.charts[b]
    rim_a = pin_chart_rims(chart_a, table, charts, degree, n_ctrl)
    rim_b = pin_chart_rims(chart_b, table, charts, degree, n_ctrl)
    fit_a = fit_scattered(
        vertices[chart_a.vertex_map], chart_a.uv, degree, degree, n_ctrl, n_ctrl, rim=rim_a
    )
    fit_b = fit_scattered(
        vertices[chart_b.vertex_map], chart_b.uv, degree, degree, n_ctrl, n_ctrl, rim=rim_b
    )
    idx = _shared_polyline_index(charts, a, b)
    poly = charts.polylines[idx]
    t = np.linspace(0.0, 1.0, 33)
    points_a = _eval_side(fit_a, _side_of(chart_a, poly), t)
    points_b = _eval_side(fit_b, _side_of(chart_b, poly), t)
    # The two patches may parameterize the shared edge in opposite directions (adjacent
    # charts wind oppositely + clamped_uniform's reflection symmetry), so compare the
    # geometric curve allowing a reversal.
    dev = min(
        float(np.max(np.linalg.norm(points_a - points_b, axis=1))),
        float(np.max(np.linalg.norm(points_a - points_b[::-1], axis=1))),
    )
    return dev, (fit_a, fit_b), table, idx


# --- fit_boundary_curve ------------------------------------------------------------------


def test_fit_boundary_curve_reproduces_analytic_polyline() -> None:
    points = _analytic_polyline(41)
    cp, knots = fit_boundary_curve(points, degree=3, n_ctrl=8)
    cp_np = np.asarray(cp, dtype=np.float64)
    assert cp_np.shape == (8, 3)
    fitted = _eval_curve(cp, knots, 3, 8, _chord_params(points))
    deviation = float(np.max(np.linalg.norm(fitted - points, axis=1)))
    assert deviation < 5e-3, f"analytic polyline deviation {deviation}"


def test_fit_boundary_curve_interpolates_endpoints_exactly() -> None:
    points = _analytic_polyline(41)
    cp, _ = fit_boundary_curve(points, degree=3, n_ctrl=8)
    cp_np = np.asarray(cp, dtype=np.float64)
    npt.assert_allclose(cp_np[0], points[0], atol=1e-10)
    npt.assert_allclose(cp_np[-1], points[-1], atol=1e-10)


def test_fit_boundary_curve_uses_clamped_uniform_knots() -> None:
    points = _analytic_polyline(41)
    _, knots = fit_boundary_curve(points, degree=3, n_ctrl=8)
    npt.assert_array_equal(
        np.asarray(knots, dtype=np.float64), np.asarray(clamped_uniform(8, 3), dtype=np.float64)
    )


def test_fit_boundary_curve_same_points_same_control_points() -> None:
    # Bitwise determinism ⇒ shared-edge identity: both charts fitting the same polyline get
    # the identical control points.
    points = _analytic_polyline(41)
    cp1, _ = fit_boundary_curve(points, degree=3, n_ctrl=8)
    cp2, _ = fit_boundary_curve(points, degree=3, n_ctrl=8)
    assert np.asarray(cp1, dtype=np.float64).tobytes() == np.asarray(cp2, dtype=np.float64).tobytes()


def test_fit_boundary_curve_handles_two_vertex_segment() -> None:
    # A single mesh edge (blob polylines 2/3/6/7, every cube edge) must still yield n_ctrl
    # control points; the fairness term makes the underdetermined system SPD and the result
    # is the geometrically exact straight segment (collinear control points).
    points = np.array([[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]], dtype=np.float64)
    cp, _ = fit_boundary_curve(points, degree=3, n_ctrl=4)
    cp_np = np.asarray(cp, dtype=np.float64)
    assert cp_np.shape == (4, 3)
    npt.assert_allclose(cp_np[0], points[0], atol=1e-10)
    npt.assert_allclose(cp_np[-1], points[1], atol=1e-10)
    direction = points[1] - points[0]
    for control_point in cp_np:
        offset = np.cross(control_point - points[0], direction)
        assert np.linalg.norm(offset) < 1e-9, f"control point {control_point} off the segment"


# --- pin_chart_rims: 4 polylines ↔ 4 uv sides --------------------------------------------


def test_pin_chart_rims_maps_four_polylines_to_four_sides() -> None:
    mesh = _blob()
    charts = cube_map_charts(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    table = fit_shared_curves(charts, vertices, degree=3, n_ctrl=4)
    for chart_id, chart in enumerate(charts.charts):
        assert len(chart.boundary) == 4, f"chart {chart_id} not 4-valent"
        rim = pin_chart_rims(chart, table, charts, 3, 4)
        assert set(rim) == {"u0", "u1", "v0", "v1"}, f"chart {chart_id}: {set(rim)}"
        for key, value in rim.items():
            assert np.asarray(value, dtype=np.float64).shape == (4, 3), f"{chart_id} {key}"


# --- THE watertightness property ---------------------------------------------------------


def test_blob_adjacent_patches_coincide_along_shared_edge() -> None:
    dev, _, _, _ = _watertight(_blob(), *_BLOB_PAIR, degree=3, n_ctrl=4)
    print(f"blob shared-edge coincidence: {dev:.3e}")
    assert dev < 1e-9, f"blob shared-edge coincidence {dev} (needs ≪ 1e-6 sew tol)"


def test_cube_adjacent_patches_coincide_along_shared_edge() -> None:
    dev, _, _, _ = _watertight(_cube(), *_CUBE_PAIR, degree=3, n_ctrl=4)
    print(f"cube shared-edge coincidence: {dev:.3e}")
    assert dev < 1e-9, f"cube shared-edge coincidence {dev} (needs ≪ 1e-6 sew tol)"


def test_blob_tiny_cap_patch_coincides_along_shared_edge() -> None:
    # The structurally hardest case for the U7.3 gate: chart 4 is a tiny cap (11 verts) with
    # two 2-vertex rims, all four rim sides pinned. Driving it through pin_chart_rims +
    # fit_scattered exercises the regularizer AND fit_scattered's ≤1e-12 junction-corner
    # consistency check for a cap, and confirms a second chart-pair's edge coincides.
    dev, _, _, _ = _watertight(_blob(), 2, 4, degree=3, n_ctrl=4)
    print(f"blob big-chart × tiny-cap shared-edge coincidence: {dev:.3e}")
    assert dev < 1e-9, f"tiny-cap shared-edge coincidence {dev} (needs ≪ 1e-6 sew tol)"


def test_shared_patch_knots_bitwise_identical() -> None:
    _, (fit_a, fit_b), table, idx = _watertight(_blob(), *_BLOB_PAIR, degree=3, n_ctrl=4)
    canonical = np.asarray(clamped_uniform(4, 3), dtype=np.float64)
    for fit in (fit_a, fit_b):
        npt.assert_array_equal(np.asarray(fit.u_knots, dtype=np.float64), canonical)
        npt.assert_array_equal(np.asarray(fit.v_knots, dtype=np.float64), canonical)
    npt.assert_array_equal(np.asarray(table[idx][1], dtype=np.float64), canonical)


# --- determinism -------------------------------------------------------------------------


def test_fit_shared_curves_and_rims_deterministic() -> None:
    mesh = _blob()
    charts = cube_map_charts(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    table1 = fit_shared_curves(charts, vertices, degree=3, n_ctrl=4)
    table2 = fit_shared_curves(charts, vertices, degree=3, n_ctrl=4)
    assert set(table1) == set(table2)
    for index in table1:
        assert (
            np.asarray(table1[index][0], dtype=np.float64).tobytes()
            == np.asarray(table2[index][0], dtype=np.float64).tobytes()
        )
        npt.assert_array_equal(
            np.asarray(table1[index][1], dtype=np.float64),
            np.asarray(table2[index][1], dtype=np.float64),
        )
    rim1 = pin_chart_rims(charts.charts[0], table1, charts, 3, 4)
    rim2 = pin_chart_rims(charts.charts[0], table2, charts, 3, 4)
    assert set(rim1) == set(rim2)
    for key in rim1:
        assert (
            np.asarray(rim1[key], dtype=np.float64).tobytes()
            == np.asarray(rim2[key], dtype=np.float64).tobytes()
        )


# --- input validation --------------------------------------------------------------------


def test_fit_boundary_curve_rejects_degenerate_polyline() -> None:
    points = np.zeros((4, 3), dtype=np.float64)  # all coincident ⇒ zero total length
    with pytest.raises(ValueError, match="degenerate|length"):
        fit_boundary_curve(points, degree=3, n_ctrl=4)


def test_fit_boundary_curve_rejects_bad_shape() -> None:
    with pytest.raises(ValueError, match=r"points must be \(N, 3\)"):
        fit_boundary_curve(np.zeros((4, 2), dtype=np.float64), degree=3, n_ctrl=4)


def test_fit_boundary_curve_rejects_nctrl_below_degree_plus_one() -> None:
    points = _analytic_polyline(41)
    with pytest.raises(ValueError, match=r"n_ctrl must be >= degree \+ 1"):
        fit_boundary_curve(points, degree=3, n_ctrl=3)  # need >= 4


def test_fit_boundary_curve_rejects_nonpositive_fairness() -> None:
    points = _analytic_polyline(41)
    with pytest.raises(ValueError, match=r"fairness .* must be > 0"):
        fit_boundary_curve(points, degree=3, n_ctrl=4, fairness=0.0)


def test_fit_boundary_curve_two_control_points_returns_exact_straight_edge() -> None:
    # n_ctrl == 2 is the Bezier-degenerate early return (only the two pinned endpoints
    # exist): it ignores every interior sample and returns the exact straight edge
    # first→last, on the canonical clamped_uniform(2, degree) knots.
    points = np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [3.0, 0.0, 2.0]], dtype=np.float64)
    cp, knots = fit_boundary_curve(points, degree=1, n_ctrl=2)
    cp_np = np.asarray(cp, dtype=np.float64)
    npt.assert_array_equal(cp_np, np.stack([points[0], points[-1]]))  # interior 1,1,1 ignored
    npt.assert_array_equal(
        np.asarray(knots, dtype=np.float64), np.asarray(clamped_uniform(2, 1), dtype=np.float64)
    )


# --- pin_chart_rims guards ---------------------------------------------------------------
# One raising test per guard. The final coverage check (boundary.py "did not cover all four
# uv sides") has NO raising test: it is unreachable for a 4-valent chart — 4 refs map to 4
# side keys drawn from the 4-element {u0,u1,v0,v1}, so any shortfall in distinct sides is a
# collision that the duplicate-side guard raises FIRST (pigeonhole). Its positive path (all
# four covered) is exercised by test_pin_chart_rims_maps_four_polylines_to_four_sides.


def test_pin_chart_rims_rejects_non_4valent_chart() -> None:
    mesh = _blob()
    charts = cube_map_charts(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    table = fit_shared_curves(charts, vertices, degree=3, n_ctrl=4)
    chart = charts.charts[0]
    three_sided = dataclasses.replace(chart, boundary=chart.boundary[:3])  # drop one side
    with pytest.raises(ValueError, match="not 4-valent"):
        pin_chart_rims(three_sided, table, charts, 3, 4)


def test_pin_chart_rims_rejects_non_canonical_knots() -> None:
    mesh = _blob()
    charts = cube_map_charts(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    table = fit_shared_curves(charts, vertices, degree=3, n_ctrl=4)
    chart = charts.charts[0]
    index0 = chart.boundary[0][0]
    control, knots = table[index0]
    bad_table = dict(table)
    bad_table[index0] = (control, np.asarray(knots, dtype=np.float64) + 1.0)  # off the canonical
    with pytest.raises(ValueError, match="not clamped_uniform"):
        pin_chart_rims(chart, bad_table, charts, 3, 4)


def test_pin_chart_rims_rejects_duplicate_side() -> None:
    # Two refs to the SAME polyline classify to the same uv side; the second occurrence trips
    # the duplicate-side guard (the first passes its cross-check, being a genuine ref).
    mesh = _blob()
    charts = cube_map_charts(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    table = fit_shared_curves(charts, vertices, degree=3, n_ctrl=4)
    chart = charts.charts[0]
    duplicated = (chart.boundary[0], chart.boundary[0], chart.boundary[1], chart.boundary[2])
    dup_chart = dataclasses.replace(chart, boundary=duplicated)
    with pytest.raises(ValueError, match="same uv side"):
        pin_chart_rims(dup_chart, table, charts, 3, 4)


def test_pin_chart_rims_rejects_orientation_desync() -> None:
    # The dual-orientation cross-check (boundary.py): the uv-geometry-derived rim order and
    # the topological ``reversed`` flag are two independent orientation sources that must
    # agree. Flip one ref's ``reversed`` flag WITHOUT touching its uv, and the two sources
    # disagree → ValueError. Guards against a U7.1 boundary-ref/uv desync silently flipping a
    # rim (which would break watertightness).
    mesh = _blob()
    charts = cube_map_charts(mesh)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    table = fit_shared_curves(charts, vertices, degree=3, n_ctrl=4)
    chart = charts.charts[0]
    index0, reversed0 = chart.boundary[0]
    desynced = ((index0, not reversed0),) + tuple(chart.boundary[1:])  # flip only the flag
    desync_chart = dataclasses.replace(chart, boundary=desynced)
    with pytest.raises(ValueError, match="rim order inconsistency"):
        pin_chart_rims(desync_chart, table, charts, 3, 4)


# --- THE watertightness property on the interior-knot path (the U7.3 gate rides this) -----


def test_blob_adjacent_patches_coincide_with_interior_knots() -> None:
    # The n_ctrl == 4 coincidence tests are Bezier fits (clamped_uniform(4, 3) has ZERO
    # interior knots). The U7.3 gate fits at n_ctrl == 8, so the watertightness lever must
    # hold once clamped_uniform introduces interior knots. n_ctrl == 6 (degree 3) has 2
    # interior knots in (0, 1); a broken interior-knot reflection symmetry would fail here
    # while passing the Bezier tests. The reviewer measured this seam at ~5e-16; the min-over-
    # reversal comparison lands on the exact-reversed branch and observes it bit-exact.
    dev, (fit_a, _fit_b), _, _ = _watertight(_blob(), *_BLOB_PAIR, degree=3, n_ctrl=6)
    interior = np.asarray(fit_a.u_knots, dtype=np.float64)
    assert np.any((interior > 0.0) & (interior < 1.0)), "n_ctrl=6 must engage interior knots"
    print(f"blob interior-knot (n_ctrl=6) shared-edge coincidence: {dev:.3e}")
    assert dev < 1e-9, f"interior-knot shared-edge coincidence {dev} (needs ≪ 1e-6 sew tol)"
