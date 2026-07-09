"""U2.2 — tests for `app/core/params.py`: parameterization + Newton point projection.

Deterministic fixed data only (no RNG anywhere):
  * chord-length (Eq. 9.5) / centripetal (Eq. 9.6) on hand-computed 4-point examples with
    exact expected parameters (1e-12), monotonicity/endpoint checks, and a case where the
    two parameterizations differ.
  * point projection (NURBS Book §6.1, grid-seeded Gauss-Newton) on the same wavy 5x6
    B-spline / NURBS net and the exact rational quarter cylinder as `test_eval.py`
    (fixtures rebuilt locally — sibling test modules are never imported):
      - on-surface points recover their (u, v) to 1e-8 with distance < 1e-10, converged;
      - points offset 0.05 along the unit normal project back to distance ~= 0.05 (1e-6)
        and strictly beat the best seed-lattice distance;
      - near-boundary points stay clamped inside [0, 1]^2 and still converge;
      - two identical calls are bitwise identical (f64 on the CPU stream).
  * deviation() rms/max match a direct numpy computation from project_points outputs.
"""

import math

import mlx.core as mx
import numpy as np
import pytest

from app.core.eval import surface_derivs, surface_point
from app.core.params import (
    centripetal_params,
    chord_length_params,
    deviation,
    project_points,
)

# --- fixed wavy 5x6 test surface (same recipe as test_eval.py, rebuilt locally) --------------
P_U, Q_V = 2, 3
NU, NV = 5, 6
U_KNOTS = [0.0, 0.0, 0.0, 0.4, 0.7, 1.0, 1.0, 1.0]  # len = NU + P_U + 1 = 8
V_KNOTS = [0.0, 0.0, 0.0, 0.0, 0.3, 0.6, 1.0, 1.0, 1.0, 1.0]  # len = NV + Q_V + 1 = 10


def _wavy_poles() -> np.ndarray:
    """Deterministic wavy control grid: x/y on a grid, z = sin/cos ripple."""
    pts = np.empty((NU, NV, 3), dtype=np.float64)
    for i in range(NU):
        for j in range(NV):
            pts[i, j] = (i * 0.5, j * 0.4, math.sin(0.9 * i) * math.cos(0.7 * j) * 0.6)
    return pts


POLES = _wavy_poles()

WEIGHTS = np.array(
    [
        [1.0, 0.5, 1.5, 0.8, 2.0, 1.2],
        [0.7, 1.0, 0.9, 1.6, 0.6, 1.1],
        [1.3, 0.75, 2.0, 0.5, 1.4, 0.95],
        [0.85, 1.7, 0.65, 1.05, 1.9, 0.55],
        [1.0, 1.25, 0.7, 1.8, 0.9, 1.5],
    ],
    dtype=np.float64,
)

# --- the exact rational quarter cylinder (same recipe as test_eval.py) ------------------------
RADIUS, HEIGHT = 1.5, 2.0
CYL_P, CYL_Q = 2, 1
CYL_U_KNOTS = [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]
CYL_V_KNOTS = [0.0, 0.0, 1.0, 1.0]
W_MID = math.sqrt(2.0) / 2.0
CYL_POLES = np.array(
    [
        [[RADIUS, 0.0, 0.0], [RADIUS, 0.0, HEIGHT]],
        [[RADIUS, RADIUS, 0.0], [RADIUS, RADIUS, HEIGHT]],
        [[0.0, RADIUS, 0.0], [0.0, RADIUS, HEIGHT]],
    ],
    dtype=np.float64,
)
CYL_WEIGHTS = np.array([[1.0, 1.0], [W_MID, W_MID], [1.0, 1.0]], dtype=np.float64)

# 20 fixed strictly-interior (u, v) pairs shared by the recovery tests (both surfaces
# have domain [0,1]^2). None sits on the default 32-point seed lattice (multiples of 1/31).
INTERIOR_UV = [
    (0.10, 0.10), (0.20, 0.30), (0.25, 0.50), (0.33, 0.77), (0.40, 0.30),
    (0.40, 0.60), (0.40, 0.85), (0.50, 0.25), (0.55, 0.90), (0.62, 0.45),
    (0.68, 0.42), (0.70, 0.15), (0.70, 0.60), (0.75, 0.35), (0.81, 0.63),
    (0.90, 0.60), (0.85, 0.20), (0.15, 0.65), (0.30, 0.15), (0.60, 0.80),
]
INTERIOR_U = np.array([u for u, _ in INTERIOR_UV], dtype=np.float64)
INTERIOR_V = np.array([v for _, v in INTERIOR_UV], dtype=np.float64)

# fixed interior (u, v) for the normal-offset tests, well away from the domain edges
OFFSET_UV = [(0.30, 0.40), (0.50, 0.60), (0.70, 0.30), (0.45, 0.75)]
OFFSET_U = np.array([u for u, _ in OFFSET_UV], dtype=np.float64)
OFFSET_V = np.array([v for _, v in OFFSET_UV], dtype=np.float64)
OFFSET_DIST = 0.05

# --- helpers ----------------------------------------------------------------------------------


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


def _np(a: mx.array) -> np.ndarray:
    return np.array(a)


def _surface_args(which: str) -> tuple:
    """(poles, weights, u_knots, v_knots, p, q) as mx arrays for the named fixture."""
    if which == "wavy":
        return (_mx64(POLES), _mx64(WEIGHTS), _mx64(U_KNOTS), _mx64(V_KNOTS), P_U, Q_V)
    if which == "wavy-nonrational":
        return (_mx64(POLES), None, _mx64(U_KNOTS), _mx64(V_KNOTS), P_U, Q_V)
    if which == "cylinder":
        return (
            _mx64(CYL_POLES),
            _mx64(CYL_WEIGHTS),
            _mx64(CYL_U_KNOTS),
            _mx64(CYL_V_KNOTS),
            CYL_P,
            CYL_Q,
        )
    raise ValueError(which)


def _eval_np(which: str, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    return _np(surface_point(*_surface_args(which), _mx64(u), _mx64(v)))


def _offset_points(which: str) -> np.ndarray:
    """Fixed points offset OFFSET_DIST along the unit normal (Su x Sv) at OFFSET_UV."""
    ders = surface_derivs(*_surface_args(which), _mx64(OFFSET_U), _mx64(OFFSET_V))
    s, su, sv = _np(ders.S), _np(ders.Su), _np(ders.Sv)
    n = np.cross(su, sv)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return s + OFFSET_DIST * n


def _seed_lattice_best_distance(which: str, points: np.ndarray, seed_grid: int = 32) -> np.ndarray:
    """Best (smallest) distance from each point to the seed_grid x seed_grid lattice."""
    grid = np.linspace(0.0, 1.0, seed_grid)
    uu, vv = np.meshgrid(grid, grid, indexing="ij")
    lattice = _eval_np(which, uu.reshape(-1), vv.reshape(-1))  # (G, 3)
    d = np.linalg.norm(points[:, None, :] - lattice[None, :, :], axis=-1)
    return d.min(axis=1)


# --- chord-length (Eq. 9.5) / centripetal (Eq. 9.6) parameterization -------------------------


def test_chord_length_hand_computed():
    # collinear 4-point example: chords 1, 2, 4 -> total 7 -> params [0, 1/7, 3/7, 1]
    pts = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0], [7.0, 0.0, 0.0]])
    params = _np(chord_length_params(_mx64(pts)))
    expected = np.array([0.0, 1.0 / 7.0, 3.0 / 7.0, 1.0])
    np.testing.assert_allclose(params, expected, rtol=0.0, atol=1e-12)


def test_centripetal_hand_computed():
    # same points: sqrt-chords 1, sqrt(2), 2 -> total 3 + sqrt(2)
    pts = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0], [7.0, 0.0, 0.0]])
    params = _np(centripetal_params(_mx64(pts)))
    total = 3.0 + math.sqrt(2.0)
    expected = np.array([0.0, 1.0 / total, (1.0 + math.sqrt(2.0)) / total, 1.0])
    np.testing.assert_allclose(params, expected, rtol=0.0, atol=1e-12)


def test_params_monotone_unit_interval_endpoints_exact():
    # a generic non-planar fixed polyline
    pts = np.array(
        [
            [0.0, 0.0, 0.0],
            [0.3, 0.1, 0.2],
            [0.5, 0.6, 0.1],
            [1.2, 0.7, 0.4],
            [1.3, 1.5, 0.9],
            [2.0, 1.6, 1.0],
        ],
        dtype=np.float64,
    )
    for fn in (chord_length_params, centripetal_params):
        params = _np(fn(_mx64(pts)))
        assert params.shape == (len(pts),)
        assert params[0] == 0.0  # endpoints exactly 0 and 1
        assert params[-1] == 1.0
        assert np.all(np.diff(params) > 0.0)  # strictly monotone
        assert np.all((params >= 0.0) & (params <= 1.0))


def test_centripetal_differs_from_chord_on_nonuniform_spacing():
    pts = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0], [7.0, 0.0, 0.0]])
    chord = _np(chord_length_params(_mx64(pts)))
    centri = _np(centripetal_params(_mx64(pts)))
    assert np.abs(chord[1:-1] - centri[1:-1]).max() > 1e-3


# --- parameterization: degenerate-input guards (FR-6: bad input -> specific error) -------------


def test_chord_length_single_point_raises():
    with pytest.raises(ValueError, match="at least 2 points"):
        chord_length_params(_mx64([[0.0, 0.0, 0.0]]))


def test_centripetal_single_point_raises():
    with pytest.raises(ValueError, match="at least 2 points"):
        centripetal_params(_mx64([[1.0, 2.0, 3.0]]))


def test_chord_length_coincident_points_raises():
    # 4 identical points -> zero total chord length; must be a clear error, not silent NaN
    pts = np.tile([0.5, -1.0, 2.0], (4, 1))
    with pytest.raises(ValueError, match="coincident"):
        chord_length_params(_mx64(pts))


def test_centripetal_coincident_points_raises():
    pts = np.tile([0.5, -1.0, 2.0], (4, 1))
    with pytest.raises(ValueError, match="coincident"):
        centripetal_params(_mx64(pts))


def test_params_two_point_endpoints_still_exact():
    # the N<2 / zero-length guards must not break the minimal valid case: exactly [0.0, 1.0]
    pts = np.array([[0.0, 0.0, 0.0], [2.0, 1.0, -3.0]], dtype=np.float64)
    for fn in (chord_length_params, centripetal_params):
        params = _np(fn(_mx64(pts)))
        assert params.shape == (2,)
        assert params[0] == 0.0
        assert params[-1] == 1.0


# --- projection: on-surface recovery -----------------------------------------------------------


def _assert_recovers(which: str) -> None:
    points = _eval_np(which, INTERIOR_U, INTERIOR_V)
    uv, dist, converged = project_points(_mx64(points), *_surface_args(which))
    uv, dist, converged = _np(uv), _np(dist), _np(converged)
    assert uv.shape == (len(points), 2)
    assert dist.shape == (len(points),)
    assert converged.shape == (len(points),)
    np.testing.assert_allclose(uv[:, 0], INTERIOR_U, rtol=0.0, atol=1e-8)
    np.testing.assert_allclose(uv[:, 1], INTERIOR_V, rtol=0.0, atol=1e-8)
    assert np.all(dist < 1e-10)
    assert converged.dtype == np.bool_
    assert np.all(converged)


def test_project_recovers_on_surface_params_wavy_rational():
    _assert_recovers("wavy")


def test_project_recovers_on_surface_params_wavy_nonrational():
    _assert_recovers("wavy-nonrational")


def test_project_recovers_on_surface_params_quarter_cylinder():
    _assert_recovers("cylinder")


# --- projection: off-surface normal offsets ----------------------------------------------------


def _assert_offset_projection(which: str) -> None:
    points = _offset_points(which)
    uv, dist, converged = project_points(_mx64(points), *_surface_args(which))
    uv, dist, converged = _np(uv), _np(dist), _np(converged)
    # the foot point of a small normal offset is the offset origin itself
    np.testing.assert_allclose(dist, OFFSET_DIST, rtol=0.0, atol=1e-6)
    np.testing.assert_allclose(uv[:, 0], OFFSET_U, rtol=0.0, atol=1e-6)
    np.testing.assert_allclose(uv[:, 1], OFFSET_V, rtol=0.0, atol=1e-6)
    assert np.all(converged)
    # Newton strictly improves on the best seed-lattice distance
    baseline = _seed_lattice_best_distance(which, points)
    assert np.all(dist < baseline)


def test_project_off_surface_normal_offset_wavy():
    _assert_offset_projection("wavy")


def test_project_off_surface_normal_offset_quarter_cylinder():
    _assert_offset_projection("cylinder")


# --- projection: domain edges -------------------------------------------------------------------


def test_project_domain_edges_clamped_and_converged():
    edge_uv = [
        (0.0, 0.0), (1.0, 1.0), (0.0, 1.0), (1.0, 0.0),  # corners
        (0.0, 0.5), (1.0, 0.37), (0.5, 0.0), (0.42, 1.0),  # edge midpoints
        (0.001, 0.999), (0.999, 0.001),  # near-corner interior
    ]
    eu = np.array([u for u, _ in edge_uv], dtype=np.float64)
    ev = np.array([v for _, v in edge_uv], dtype=np.float64)
    points = _eval_np("wavy", eu, ev)
    uv, dist, converged = project_points(_mx64(points), *_surface_args("wavy"))
    uv, dist, converged = _np(uv), _np(dist), _np(converged)
    assert np.all((uv >= 0.0) & (uv <= 1.0))  # clamped to the domain, never outside
    np.testing.assert_allclose(uv[:, 0], eu, rtol=0.0, atol=1e-8)
    np.testing.assert_allclose(uv[:, 1], ev, rtol=0.0, atol=1e-8)
    assert np.all(dist < 1e-10)
    assert np.all(converged)


def test_project_empty_points_raises():
    empty = _mx64(np.zeros((0, 3)))
    with pytest.raises(ValueError, match="at least one point"):
        project_points(empty, *_surface_args("wavy"))


def test_project_edge_constrained_optimum_reports_not_converged():
    # A point pushed in the -u tangent direction beyond the u=0 rim: its nearest surface
    # point is clamped to the u=0 edge, so the residual stays ~parallel to Su and cannot be
    # made orthogonal. Projection reaches that constrained minimum, but `converged` reports
    # False because it checks the book's ε1/ε2 criteria, not the KKT boundary condition
    # (see the Projection.converged / project_points docstrings).
    delta = 0.1
    ders = surface_derivs(*_surface_args("wavy"), _mx64([0.0]), _mx64([0.5]))
    s, su = _np(ders.S)[0], _np(ders.Su)[0]
    p = s - delta * su / np.linalg.norm(su)  # off the domain, beyond the u=0 edge
    uv, dist, converged = project_points(_mx64([p]), *_surface_args("wavy"))
    uv, dist, converged = _np(uv), _np(dist), _np(converged)
    assert np.all((uv >= 0.0) & (uv <= 1.0))  # clamped to the domain, never outside
    assert uv[0, 0] < 1e-6  # foot pinned to the u=0 rim (clamped)
    assert dist[0] > 1e-9  # genuinely off-surface: ε1 point-coincidence not met
    assert not bool(converged[0])  # constrained optimum still reads as not-converged


# --- determinism --------------------------------------------------------------------------------


def test_project_points_bitwise_deterministic():
    points = _offset_points("wavy")
    uv1, dist1, conv1 = project_points(_mx64(points), *_surface_args("wavy"))
    uv2, dist2, conv2 = project_points(_mx64(points), *_surface_args("wavy"))
    assert np.array_equal(_np(uv1), _np(uv2))  # bitwise identical (f64, CPU stream)
    assert np.array_equal(_np(dist1), _np(dist2))
    assert np.array_equal(_np(conv1), _np(conv2))


# --- deviation(): the U5.1 / FR-9 metric --------------------------------------------------------


def test_deviation_matches_direct_numpy_computation():
    # a fixed mix of on-surface and offset points
    on_surface = _eval_np("wavy", INTERIOR_U, INTERIOR_V)
    points = np.concatenate([on_surface, _offset_points("wavy")], axis=0)
    rms, maxd = deviation(_mx64(points), *_surface_args("wavy"))
    _, dist, _ = project_points(_mx64(points), *_surface_args("wavy"))
    d = _np(dist)
    assert isinstance(rms, float)
    assert isinstance(maxd, float)
    np.testing.assert_allclose(rms, float(np.sqrt(np.mean(d**2))), rtol=0.0, atol=1e-12)
    np.testing.assert_allclose(maxd, float(d.max()), rtol=0.0, atol=1e-12)
