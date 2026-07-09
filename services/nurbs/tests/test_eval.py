"""U1.2 — oracle-parity tests for the MLX tensor-product surface evaluator (`app/core/eval.py`).

Oracles (test-only, never imported by app/ code — SPEC-12 licensing rule):
  * geomdl BSpline.Surface / NURBS.Surface `evaluate_single` + `derivatives(order=1)`
    (Piegl & Tiller A3.5/A3.6/A4.3/A4.4 — the same normative algorithms, MIT).
  * scipy.interpolate.NdBSpline (independent non-rational tensor-product cross-check).
  * The exact rational quarter circle (weights [1, sqrt(2)/2, 1]) extruded to a quarter
    cylinder — closed-form Bernstein analytic parameterization, NOT uniform in angle.

Everything is deterministic: fixed hand-written knot vectors (flat/textbook, clamped,
interior knots in both directions), a formula-built wavy control net, hand-picked
non-uniform weights in [0.5, 2.0], and a fixed list of (u, v) pairs covering corners,
edges, interior values and the knot values themselves. No RNG anywhere.

Tolerances per SPEC-12 §5.3 / D-9 two-precision policy: 1e-10..1e-12 in float64 on the
CPU stream (1e-8 for first derivatives vs geomdl), 1e-4 sanity in float32 on the default
(GPU) stream.

`surface_derivs` returns the `SurfaceDerivs` NamedTuple `(S, Su, Sv)`, each `(..., 3)`.
"""

import math

import mlx.core as mx
import numpy as np
import pytest
from geomdl import BSpline, NURBS
from scipy.interpolate import NdBSpline

from app.core.eval import design_matrix, surface_derivs, surface_point

# --- fixed non-rational/rational test surface: degrees (2, 3), 5x6 net ----------------------
P_U, Q_V = 2, 3
NU, NV = 5, 6
# clamped, with interior knots in BOTH directions (flat/textbook form)
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

# hand-picked non-uniform weights in [0.5, 2.0] (one per control point, 5x6)
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

# >= 20 fixed (u, v) pairs: corners, edge midpoints, knot values (u: 0.4/0.7, v: 0.3/0.6)
# crossed with each other and with interior values, plus scattered interior points.
UV_PAIRS = [
    (0.0, 0.0), (0.0, 1.0), (1.0, 0.0), (1.0, 1.0),  # corners
    (0.0, 0.45), (1.0, 0.3), (0.35, 0.0), (0.62, 1.0),  # edges (incl. a v-knot on an edge)
    (0.4, 0.3), (0.4, 0.6), (0.7, 0.3), (0.7, 0.6),  # knot x knot
    (0.4, 0.85), (0.7, 0.15), (0.2, 0.3), (0.9, 0.6),  # knot lines x interior
    (0.1, 0.1), (0.25, 0.5), (0.33, 0.77), (0.5, 0.25),
    (0.55, 0.9), (0.68, 0.42), (0.81, 0.63), (0.95, 0.05),  # interior
]
U_VALS = np.array([u for u, _ in UV_PAIRS], dtype=np.float64)
V_VALS = np.array([v for _, v in UV_PAIRS], dtype=np.float64)

# --- the exact rational quarter cylinder -----------------------------------------------------
# Standard degree-2 rational quarter circle in u (weights [1, sqrt(2)/2, 1]) extruded
# linearly in v (degree 1): every point lies exactly on x^2 + y^2 = R^2, z = v * H.
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
)  # (nu=3 arc, nv=2 extrusion, 3)
CYL_WEIGHTS = np.array([[1.0, 1.0], [W_MID, W_MID], [1.0, 1.0]], dtype=np.float64)
CYL_U = np.array([0.0, 0.05, 0.15, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 0.95, 1.0])
CYL_V = np.array([0.0, 0.3, 0.5, 0.7, 1.0])


def _arc_analytic(u: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Closed-form Bernstein/rational quarter circle — the analytic cos/sin point at u.

    The angle theta(u) = atan2(y, x) is NOT u * pi/2: the standard weights make the
    angular spacing non-uniform, which the tests assert explicitly.
    """
    b0 = (1.0 - u) ** 2
    b1 = 2.0 * u * (1.0 - u) * W_MID
    b2 = u**2
    w = b0 + b1 + b2
    return RADIUS * (b0 + b1) / w, RADIUS * (b1 + b2) / w


# --- helpers (test_basis.py conventions) -----------------------------------------------------


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


def _np(a: mx.array) -> np.ndarray:
    return np.array(a)


def _eval64(poles, weights, u_knots, v_knots, p, q, u, v) -> np.ndarray:
    pts = surface_point(
        _mx64(poles),
        None if weights is None else _mx64(weights),
        _mx64(u_knots),
        _mx64(v_knots),
        p,
        q,
        _mx64(u),
        _mx64(v),
    )
    return _np(pts)


def _derivs64(poles, weights, u_knots, v_knots, p, q, u, v):
    return surface_derivs(
        _mx64(poles),
        None if weights is None else _mx64(weights),
        _mx64(u_knots),
        _mx64(v_knots),
        p,
        q,
        _mx64(u),
        _mx64(v),
    )


def _geomdl_bspline() -> BSpline.Surface:
    surf = BSpline.Surface()
    surf.degree_u = P_U
    surf.degree_v = Q_V
    # geomdl flat ordering is u-major (index i*NV + j) — verified against clamped corners
    surf.set_ctrlpts(POLES.reshape(-1, 3).tolist(), NU, NV)
    surf.knotvector_u = U_KNOTS
    surf.knotvector_v = V_KNOTS
    return surf


def _geomdl_nurbs() -> NURBS.Surface:
    surf = NURBS.Surface()
    surf.degree_u = P_U
    surf.degree_v = Q_V
    ctrlptsw = np.concatenate([POLES * WEIGHTS[..., None], WEIGHTS[..., None]], axis=-1)
    surf.set_ctrlpts(ctrlptsw.reshape(-1, 4).tolist(), NU, NV)
    surf.knotvector_u = U_KNOTS
    surf.knotvector_v = V_KNOTS
    return surf


# --- A3.5 / A4.3: surface_point vs geomdl ----------------------------------------------------


def test_surface_point_matches_geomdl_bspline():
    ours = _eval64(POLES, None, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    surf = _geomdl_bspline()
    expected = np.array([surf.evaluate_single((u, v)) for u, v in UV_PAIRS])
    assert ours.shape == (len(UV_PAIRS), 3)
    np.testing.assert_allclose(ours, expected, rtol=0.0, atol=1e-10)


def test_surface_point_matches_geomdl_nurbs():
    ours = _eval64(POLES, WEIGHTS, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    surf = _geomdl_nurbs()
    expected = np.array([surf.evaluate_single((u, v)) for u, v in UV_PAIRS])
    np.testing.assert_allclose(ours, expected, rtol=0.0, atol=1e-10)


def test_surface_point_matches_scipy_ndbspline():
    ours = _eval64(POLES, None, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    spl = NdBSpline(
        (np.asarray(U_KNOTS, dtype=np.float64), np.asarray(V_KNOTS, dtype=np.float64)),
        POLES,
        (P_U, Q_V),
    )
    expected = spl(np.stack([U_VALS, V_VALS], axis=-1))
    np.testing.assert_allclose(ours, expected, rtol=0.0, atol=1e-10)


def test_corners_interpolate_control_net():
    # clamped surface: the four corners reproduce the corner control points exactly
    ours = _eval64(POLES, WEIGHTS, U_KNOTS, V_KNOTS, P_U, Q_V, [0.0, 0.0, 1.0, 1.0], [0.0, 1.0, 0.0, 1.0])
    expected = np.array([POLES[0, 0], POLES[0, -1], POLES[-1, 0], POLES[-1, -1]])
    np.testing.assert_allclose(ours, expected, rtol=0.0, atol=1e-12)


# --- A3.6 / A4.4 (order 1): surface_derivs vs geomdl -----------------------------------------


@pytest.mark.parametrize(
    ("build", "weights"), [(_geomdl_bspline, None), (_geomdl_nurbs, WEIGHTS)], ids=["bspline", "nurbs"]
)
def test_surface_derivs_match_geomdl(build, weights):
    ders = _derivs64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    surf = build()
    expected = [surf.derivatives(u, v, order=1) for u, v in UV_PAIRS]
    exp_s = np.array([d[0][0] for d in expected])
    exp_su = np.array([d[1][0] for d in expected])
    exp_sv = np.array([d[0][1] for d in expected])
    np.testing.assert_allclose(_np(ders.S), exp_s, rtol=0.0, atol=1e-8)
    np.testing.assert_allclose(_np(ders.Su), exp_su, rtol=0.0, atol=1e-8)
    np.testing.assert_allclose(_np(ders.Sv), exp_sv, rtol=0.0, atol=1e-8)


@pytest.mark.parametrize("weights", [None, WEIGHTS], ids=["bspline", "nurbs"])
def test_derivs_S_equals_surface_point(weights):
    ders = _derivs64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    pts = _eval64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(_np(ders.S), pts, rtol=0.0, atol=1e-12)


# --- the exact rational quarter cylinder ------------------------------------------------------


def test_quarter_cylinder_points_are_exactly_on_cylinder():
    uu, vv = np.meshgrid(CYL_U, CYL_V, indexing="ij")
    pts = _eval64(CYL_POLES, CYL_WEIGHTS, CYL_U_KNOTS, CYL_V_KNOTS, CYL_P, CYL_Q, uu, vv)
    assert pts.shape == (*uu.shape, 3)
    radii_sq = pts[..., 0] ** 2 + pts[..., 1] ** 2
    np.testing.assert_allclose(radii_sq, RADIUS**2, rtol=0.0, atol=1e-12)
    # degree-1 clamped extrusion with knots [0,0,1,1]: z == v * HEIGHT exactly
    np.testing.assert_allclose(pts[..., 2], vv * HEIGHT, rtol=0.0, atol=1e-12)


def test_quarter_cylinder_matches_analytic_parameterization():
    mid_v = np.full_like(CYL_U, 0.5)
    pts = _eval64(CYL_POLES, CYL_WEIGHTS, CYL_U_KNOTS, CYL_V_KNOTS, CYL_P, CYL_Q, CYL_U, mid_v)
    exp_x, exp_y = _arc_analytic(CYL_U)
    np.testing.assert_allclose(pts[:, 0], exp_x, rtol=0.0, atol=1e-12)
    np.testing.assert_allclose(pts[:, 1], exp_y, rtol=0.0, atol=1e-12)
    # every point is the analytic (R cos, R sin) of its own angle
    theta = np.arctan2(pts[:, 1], pts[:, 0])
    np.testing.assert_allclose(pts[:, 0], RADIUS * np.cos(theta), rtol=0.0, atol=1e-12)
    np.testing.assert_allclose(pts[:, 1], RADIUS * np.sin(theta), rtol=0.0, atol=1e-12)
    # sweep: theta runs 0 -> pi/2 monotonically ...
    np.testing.assert_allclose(theta[0], 0.0, rtol=0.0, atol=1e-12)
    np.testing.assert_allclose(theta[-1], math.pi / 2.0, rtol=0.0, atol=1e-12)
    assert np.all(np.diff(theta) > 0.0)
    # ... but the angle spacing is NOT uniform in u (do not "simplify" to theta = u*pi/2)
    assert np.abs(theta[1:-1] - CYL_U[1:-1] * math.pi / 2.0).max() > 1e-3


def test_quarter_cylinder_derivatives_analytic():
    uu, vv = np.meshgrid(CYL_U, CYL_V, indexing="ij")
    ders = _derivs64(CYL_POLES, CYL_WEIGHTS, CYL_U_KNOTS, CYL_V_KNOTS, CYL_P, CYL_Q, uu, vv)
    s, su, sv = _np(ders.S), _np(ders.Su), _np(ders.Sv)
    # extrusion direction is exactly (0, 0, HEIGHT)
    np.testing.assert_allclose(sv, np.broadcast_to([0.0, 0.0, HEIGHT], sv.shape), rtol=0.0, atol=1e-12)
    # Su is tangent to the circle: radially orthogonal in xy, no z component
    radial_dot = s[..., 0] * su[..., 0] + s[..., 1] * su[..., 1]
    np.testing.assert_allclose(radial_dot, 0.0, rtol=0.0, atol=1e-10)
    np.testing.assert_allclose(su[..., 2], 0.0, rtol=0.0, atol=1e-12)


# --- design_matrix: the U3/U5 workhorse -------------------------------------------------------


def test_design_matrix_reproduces_nonrational_eval():
    B = _np(design_matrix(_mx64(U_VALS), _mx64(V_VALS), _mx64(U_KNOTS), _mx64(V_KNOTS), P_U, Q_V, NU, NV))
    assert B.shape == (len(UV_PAIRS), NU * NV)
    pts = B @ POLES.reshape(NU * NV, 3)
    direct = _eval64(POLES, None, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(pts, direct, rtol=0.0, atol=1e-12)


def test_design_matrix_drives_rational_eval_via_homogeneous_poles():
    B = _np(design_matrix(_mx64(U_VALS), _mx64(V_VALS), _mx64(U_KNOTS), _mx64(V_KNOTS), P_U, Q_V, NU, NV))
    pw = np.concatenate([POLES * WEIGHTS[..., None], WEIGHTS[..., None]], axis=-1)
    hom = B @ pw.reshape(NU * NV, 4)
    pts = hom[:, :3] / hom[:, 3:4]
    direct = _eval64(POLES, WEIGHTS, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(pts, direct, rtol=0.0, atol=1e-12)


def test_design_matrix_rows_partition_unity():
    B = _np(design_matrix(_mx64(U_VALS), _mx64(V_VALS), _mx64(U_KNOTS), _mx64(V_KNOTS), P_U, Q_V, NU, NV))
    np.testing.assert_allclose(B.sum(axis=1), np.ones(len(UV_PAIRS)), rtol=0.0, atol=1e-10)
    # each row has exactly (p+1)(q+1) structurally-placed basis products
    per_row = (np.abs(B) > 0.0).sum(axis=1)
    assert per_row.max() <= (P_U + 1) * (Q_V + 1)


def test_design_matrix_flattens_batched_parameters():
    u = np.ascontiguousarray(U_VALS[:6].reshape(2, 3))
    v = np.ascontiguousarray(V_VALS[:6].reshape(2, 3))
    B = _np(design_matrix(_mx64(u), _mx64(v), _mx64(U_KNOTS), _mx64(V_KNOTS), P_U, Q_V, NU, NV))
    flat = _np(
        design_matrix(_mx64(U_VALS[:6]), _mx64(V_VALS[:6]), _mx64(U_KNOTS), _mx64(V_KNOTS), P_U, Q_V, NU, NV)
    )
    assert B.shape == (6, NU * NV)
    np.testing.assert_allclose(B, flat, rtol=0.0, atol=0.0)


# --- float32 default-stream sanity (D-9) ------------------------------------------------------


@pytest.mark.parametrize("weights", [None, WEIGHTS], ids=["bspline", "nurbs"])
def test_f32_default_stream_sanity(weights):
    pts32 = surface_point(
        mx.array(POLES.astype(np.float32)),
        None if weights is None else mx.array(weights.astype(np.float32)),
        mx.array(np.asarray(U_KNOTS, dtype=np.float32)),
        mx.array(np.asarray(V_KNOTS, dtype=np.float32)),
        P_U,
        Q_V,
        mx.array(U_VALS.astype(np.float32)),
        mx.array(V_VALS.astype(np.float32)),
    )
    assert pts32.dtype == mx.float32
    expected = _eval64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(_np(pts32), expected, rtol=0.0, atol=1e-4)


# --- batch shapes ------------------------------------------------------------------------------


@pytest.mark.parametrize("shape", [(7,), (2, 3)], ids=["vec7", "grid2x3"])
@pytest.mark.parametrize("weights", [None, WEIGHTS], ids=["bspline", "nurbs"])
def test_batch_shapes(shape, weights):
    count = int(np.prod(shape))
    u = np.ascontiguousarray(U_VALS[:count].reshape(shape))  # numpy-side reshape before mx conversion
    v = np.ascontiguousarray(V_VALS[:count].reshape(shape))
    pts = _eval64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, u, v)
    assert pts.shape == (*shape, 3)
    ders = _derivs64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, u, v)
    assert _np(ders.S).shape == (*shape, 3)
    assert _np(ders.Su).shape == (*shape, 3)
    assert _np(ders.Sv).shape == (*shape, 3)
    flat = _eval64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS[:count], V_VALS[:count])
    np.testing.assert_allclose(pts.reshape(count, 3), flat, rtol=0.0, atol=0.0)
