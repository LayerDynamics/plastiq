"""U3.1 — tests for the gridded separable least-squares B-spline fit (`app/core/fit_lsq.py`).

The fit is A9.7 (separable) of The NURBS Book: parameterize each row/column and average
(A9.3), place interior knots by averaging (Eqs. 9.68/9.69), then fit each direction with
the endpoint-interpolating A9.6 curve LSQ (corners interpolated exactly, interior control
points by reduced normal equations solved with Cholesky on the float64 CPU stream, D-9).

Oracles (test-only, never imported by app/ code — SPEC-12 licensing rule):
  * geomdl.fitting.approximate_surface (A9.7, MIT). geomdl's default parameterization is
    chord-length (``centripetal=False``); our default is centripetal — so the parity test
    pins BOTH to chord length and compares evaluated SURFACE POINTS (control points agree
    to solver precision because our `averaging_knots` == geomdl `compute_knot_vector2` and
    our per-curve chord formula == geomdl `compute_params_curve`, verified in U3.1).

Everything is deterministic (fixed grids, no RNG). Tolerances are stated per test (float64
on the CPU stream, SPEC-12 §5.3): knot-vector parity holds to 1e-12, corner interpolation and
the geomdl surface-point parity to 1e-10, the exact-patch and Cholesky-solve residuals to
1e-9, and repeated fits are bitwise identical.
"""

import math

import mlx.core as mx
import numpy as np
import pytest
from geomdl import fitting

from app.core.eval import surface_point
from app.core.fit_lsq import (
    GridFit,
    _chol_solve,
    _design_matrix_1d,
    fit_grid,
    grid_params,
)
from app.core.knots import averaging_knots

# --- fixtures -----------------------------------------------------------------------------------

P = Q = 3
GRID_N = 16


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


def _np(a: mx.array) -> np.ndarray:
    return np.array(a)


def _sincos_grid(n: int = GRID_N) -> np.ndarray:
    """z = sin(x)*cos(y) on an n×n grid over [0, 1]^2; x, y are the grid coords."""
    xs = np.linspace(0.0, 1.0, n)
    ys = np.linspace(0.0, 1.0, n)
    grid = np.empty((n, n, 3), dtype=np.float64)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            grid[i, j] = (x, y, math.sin(x) * math.cos(y))
    return grid


def _plane_grid(n: int = GRID_N) -> np.ndarray:
    """A tilted plane z = 0.3*x - 0.7*y + 0.2 (exactly in the degree-3 spline space)."""
    xs = np.linspace(0.0, 1.0, n)
    ys = np.linspace(0.0, 1.0, n)
    grid = np.empty((n, n, 3), dtype=np.float64)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            grid[i, j] = (x, y, 0.3 * x - 0.7 * y + 0.2)
    return grid


def _bilinear_grid(n: int = GRID_N) -> np.ndarray:
    """A bilinear patch z = 0.2 + 0.5*x - 0.3*y + 0.9*x*y (also exactly representable)."""
    xs = np.linspace(0.0, 1.0, n)
    ys = np.linspace(0.0, 1.0, n)
    grid = np.empty((n, n, 3), dtype=np.float64)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            grid[i, j] = (x, y, 0.2 + 0.5 * x - 0.3 * y + 0.9 * x * y)
    return grid


def _eval_on_params(fit: GridFit, uk: mx.array, vl: mx.array) -> np.ndarray:
    """Evaluate the fitted surface on the tensor grid of the data parameters (uk × vl).

    Parameter grids are built in numpy then converted (f64 MLX ops are CPU-stream-only, §5.3;
    surface_point routes its own ops through the CPU stream — the test only feeds it arrays).
    """
    uu, vv = np.meshgrid(_np(uk), _np(vl), indexing="ij")  # (Nu, Nv)
    S = surface_point(fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q, _mx64(uu), _mx64(vv))
    return _np(S)


def _max_deviation(grid: np.ndarray, p: int, q: int, nu: int, nv: int, param: str) -> float:
    """Max Euclidean distance between the fit at the data params and the sample points."""
    g = _mx64(grid)
    fit = fit_grid(g, p, q, nu, nv, param=param)
    uk, vl = grid_params(g, param=param)
    S = _eval_on_params(fit, uk, vl)
    return float(np.max(np.linalg.norm(S - grid, axis=-1)))


# --- return shape / type ------------------------------------------------------------------------


def test_fit_grid_returns_evaluatable_gridfit():
    fit = fit_grid(_mx64(_sincos_grid()), P, Q, 12, 10)
    assert isinstance(fit, GridFit)
    assert fit.p == P and fit.q == Q
    # poles + knots are float64 mx.arrays so the tuple drops straight into eval.surface_point
    assert isinstance(fit.poles, mx.array) and fit.poles.dtype == mx.float64
    assert fit.poles.shape == (12, 10, 3)
    assert isinstance(fit.u_knots, mx.array) and fit.u_knots.dtype == mx.float64
    assert isinstance(fit.v_knots, mx.array) and fit.v_knots.dtype == mx.float64
    assert fit.u_knots.shape == (12 + P + 1,)  # knot-count law
    assert fit.v_knots.shape == (10 + Q + 1,)


# --- corners interpolated exactly (A9.7 pins the four data corners) -----------------------------


@pytest.mark.parametrize("param", ["centripetal", "chord"])
def test_corners_interpolate_exactly(param):
    grid = _sincos_grid()
    fit = fit_grid(_mx64(grid), P, Q, 12, 12, param=param)
    corners_uv = ([0.0, 0.0, 1.0, 1.0], [0.0, 1.0, 0.0, 1.0])
    got = _np(surface_point(fit.poles, None, fit.u_knots, fit.v_knots, P, Q, _mx64(corners_uv[0]), _mx64(corners_uv[1])))
    expected = np.array([grid[0, 0], grid[0, -1], grid[-1, 0], grid[-1, -1]])
    np.testing.assert_allclose(got, expected, rtol=0.0, atol=1e-10)


# --- accuracy on sin*cos ------------------------------------------------------------------------


def test_sincos_max_deviation_below_1e_3_at_12():
    dev = _max_deviation(_sincos_grid(), P, Q, 12, 12, "centripetal")
    assert dev < 1e-3, dev


def test_sincos_deviation_strictly_decreases_with_grid_size():
    grid = _sincos_grid()
    devs = [_max_deviation(grid, P, Q, n, n, "centripetal") for n in (8, 12, 16)]
    assert devs[0] > devs[1] > devs[2], devs


# --- plane + bilinear patch fit essentially exactly (unbiased separable solve) ------------------


@pytest.mark.parametrize("param", ["centripetal", "chord"])
def test_plane_fits_exactly(param):
    dev = _max_deviation(_plane_grid(), P, Q, 8, 8, param)
    assert dev < 1e-9, dev


@pytest.mark.parametrize("param", ["centripetal", "chord"])
def test_bilinear_patch_fits_exactly(param):
    dev = _max_deviation(_bilinear_grid(), P, Q, 8, 8, param)
    assert dev < 1e-9, dev


# --- geomdl cross-check (chord mode on both, compare evaluated surface points) ------------------


def test_matches_geomdl_approximate_surface():
    grid = _sincos_grid()
    nu = nv = 10
    fit = fit_grid(_mx64(grid), P, Q, nu, nv, param="chord")

    # geomdl flat ordering is u-major (index u*size_v + v) — same as grid.reshape(-1, 3)
    pts = grid.reshape(-1, 3).tolist()
    surf = fitting.approximate_surface(
        pts, GRID_N, GRID_N, P, Q, ctrlpts_size_u=nu, ctrlpts_size_v=nv, centripetal=False
    )

    # fixed (u, v) sample set spanning corners, edges and the interior
    uv = [
        (0.0, 0.0), (1.0, 1.0), (0.0, 1.0), (1.0, 0.0),
        (0.13, 0.27), (0.5, 0.5), (0.82, 0.41), (0.31, 0.9), (0.67, 0.05), (0.95, 0.78),
    ]
    us = _mx64([u for u, _ in uv])
    vs = _mx64([v for _, v in uv])
    ours = _np(surface_point(fit.poles, None, fit.u_knots, fit.v_knots, P, Q, us, vs))
    theirs = np.array([surf.evaluate_single((u, v)) for u, v in uv])
    np.testing.assert_allclose(ours, theirs, rtol=0.0, atol=1e-10)  # real parity ~1.1e-15


def test_averaging_knots_matches_geomdl_knot_vector():
    # the load-bearing parity fact: our averaging_knots == geomdl compute_knot_vector2
    grid = _sincos_grid()
    uk, _ = grid_params(_mx64(grid), param="chord")
    ours = averaging_knots([float(x) for x in _np(uk)], 10, P)
    theirs = fitting.compute_knot_vector2(P, GRID_N, 10, [float(x) for x in _np(uk)])
    np.testing.assert_allclose(ours, theirs, rtol=0.0, atol=1e-12)


# --- Cholesky path is real: reduced normal matrix is SPD + solve residual ~ 0 -------------------


def test_reduced_normal_matrix_is_spd_and_chol_solve_is_exact():
    grid = _sincos_grid()
    nu = 12
    uk, _ = grid_params(_mx64(grid), param="centripetal")
    u_knots = _mx64(averaging_knots([float(x) for x in _np(uk)], nu, P))
    N = _np(_design_matrix_1d(uk, u_knots, P, nu))  # (GRID_N, nu) — slice in numpy (f64 CPU, §5.3)
    n_int = nu - 2
    Nint = N[1 : GRID_N - 1, 1 : nu - 1]  # (GRID_N-2, n_int)
    gram = Nint.T @ Nint
    # symmetric-positive-definite: symmetric + all eigenvalues strictly positive
    np.testing.assert_allclose(gram, gram.T, rtol=0.0, atol=1e-12)
    assert np.all(np.linalg.eigvalsh(gram) > 0.0)
    # the real Cholesky path recovers a known solution: (NᵀN) x = (NᵀN) x_true
    x_true = np.cos(np.arange(n_int, dtype=np.float64))[:, None] * np.array([[1.0, -2.0, 0.5]])
    rhs = _mx64(gram @ x_true)
    x = _np(_chol_solve(_mx64(gram), rhs))
    np.testing.assert_allclose(x, x_true, rtol=0.0, atol=1e-9)
    residual = np.linalg.norm(gram @ x - _np(rhs))
    assert residual < 1e-9, residual


# --- degenerate grid: a coincident grid line is rejected, never a silent NaN (FR-6) -------------


def test_fit_grid_coincident_row_raises_not_nan():
    # collapse an entire row to a single point -> zero chord along that v-grid line.
    # Without the guard, _normalized_cumulative divides by a zero per-line total and the
    # NaN knots/poles slip silently past averaging_knots (all its NaN comparisons are False)
    # to the output — the FR-6 "never a silent NaN" contract params.py enforces.
    grid = _sincos_grid()
    grid[3, :, :] = grid[3, 0, :]  # row 3 is now one coincident point
    with pytest.raises(ValueError, match="degenerate grid: zero chord length"):
        fit_grid(_mx64(grid), P, Q, 12, 12)


def test_fit_grid_coincident_column_raises_not_nan():
    grid = _sincos_grid()
    grid[:, 2, :] = grid[0, 2, :]  # column 2 collapsed -> zero chord along a u-grid line
    with pytest.raises(ValueError, match="degenerate grid: zero chord length"):
        fit_grid(_mx64(grid), P, Q, 12, 12)


# --- Bezier-degenerate curve branch: n_ctrl <= 2 pins to the data endpoints ---------------------


def test_bezier_degenerate_branch_pins_endpoints():
    # p=q=1, nu=nv=2 drives _fit_curve_batch's n_ctrl <= 2 branch in BOTH directions: only the
    # two pinned endpoints survive per curve, so the four poles are exactly the four data corners.
    grid = _sincos_grid()
    fit = fit_grid(_mx64(grid), 1, 1, 2, 2)
    assert fit.poles.shape == (2, 2, 3)
    expected = np.array([[grid[0, 0], grid[0, -1]], [grid[-1, 0], grid[-1, -1]]])
    np.testing.assert_array_equal(_np(fit.poles), expected)


# --- input validation: each fit_grid guard raises a clear ValueError ----------------------------


def test_fit_grid_rejects_bad_param():
    # valid shape + nu/nv so execution reaches the param check inside grid_params
    with pytest.raises(ValueError, match="param must be 'centripetal' or 'chord'"):
        fit_grid(_mx64(_sincos_grid()), P, Q, 8, 8, param="uniform")


def test_fit_grid_rejects_bad_points_shape():
    bad = np.zeros((GRID_N, GRID_N), dtype=np.float64)  # missing the trailing 3-vector axis
    with pytest.raises(ValueError, match=r"points_grid must be \(Nu, Nv, 3\)"):
        fit_grid(_mx64(bad), P, Q, 8, 8)


def test_fit_grid_rejects_nu_out_of_range():
    with pytest.raises(ValueError, match="nu must satisfy"):
        fit_grid(_mx64(_sincos_grid()), P, Q, 2, 8)  # nu=2 < p+1=4


def test_fit_grid_rejects_nv_out_of_range():
    with pytest.raises(ValueError, match="nv must satisfy"):
        fit_grid(_mx64(_sincos_grid()), P, Q, 8, 2)  # nv=2 < q+1=4


# --- f64 / CPU determinism: two runs bitwise identical ------------------------------------------


def test_fit_is_bitwise_deterministic():
    grid = _mx64(_sincos_grid())
    a = fit_grid(grid, P, Q, 12, 12, param="centripetal")
    b = fit_grid(grid, P, Q, 12, 12, param="centripetal")
    assert np.array_equal(_np(a.poles), _np(b.poles))
    assert np.array_equal(_np(a.u_knots), _np(b.u_knots))
    assert np.array_equal(_np(a.v_knots), _np(b.v_knots))
