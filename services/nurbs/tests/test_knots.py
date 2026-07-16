"""U2.1 — tests for knot-vector operations (`app/core/knots.py`).

Oracles (test-only, never imported by app/ code — SPEC-12 licensing rule):
  * geomdl.operations.insert_knot on BSpline/NURBS curves and surfaces (Piegl & Tiller
    A5.1/A5.3 — the same normative algorithms, MIT).
  * scipy.interpolate.BSpline (independent curve evaluation for insertion invariance).
  * app.core.eval.surface_point — OUR evaluator: the invariance tests assert that knot
    insertion/refinement leaves the evaluated surface bitwise-near-identical (1e-10),
    which is the entire point of the knot ops.
  * app.schema.NurbsSurface.flat_u_knots()/flat_v_knots() — the schema-level reference
    expansion the array-level compact<->flat conversion must agree with (§6.2 inv. 5).

Everything is deterministic: the wavy 5x6 net of test_eval.py is rebuilt locally
(sibling test modules are never imported), hand-written knot vectors, a fixed list of
24 (u, v) pairs, a fixed clustered 25-value parameter list. No RNG anywhere.

Convention under test (documented in app/core/knots.py): knot vectors and
multiplicities are plain Python lists; pole/weight grids are numpy float64 arrays.
Both convert cleanly to the MLX evaluators via mx.array(..., dtype=mx.float64).
"""

import math

import mlx.core as mx
import numpy as np
import pytest
from geomdl import BSpline, NURBS, operations
from scipy.interpolate import BSpline as ScipyBSpline

from app.core.eval import surface_point
from app.core.knots import (
    averaging_knots,
    clamped_uniform,
    compact_to_flat,
    flat_to_compact,
    insert_knot_curve,
    insert_knot_surface,
    refine_knots_curve,
    refine_knots_surface,
)
from app.schema import NurbsSurface

# --- fixed test surface: the wavy 5x6 net from test_eval.py, rebuilt locally ----------------
P_U, Q_V = 2, 3
NU, NV = 5, 6
U_KNOTS = [0.0, 0.0, 0.0, 0.4, 0.7, 1.0, 1.0, 1.0]  # len = NU + P_U + 1 = 8
V_KNOTS = [0.0, 0.0, 0.0, 0.0, 0.3, 0.6, 1.0, 1.0, 1.0, 1.0]  # len = NV + Q_V + 1 = 10
U_COMPACT = ([0.0, 0.4, 0.7, 1.0], [3, 1, 1, 3])
V_COMPACT = ([0.0, 0.3, 0.6, 1.0], [4, 1, 1, 4])


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

# 24 fixed (u, v) pairs: corners, edges, knot values, interior (test_eval.py's list)
UV_PAIRS = [
    (0.0, 0.0), (0.0, 1.0), (1.0, 0.0), (1.0, 1.0),
    (0.0, 0.45), (1.0, 0.3), (0.35, 0.0), (0.62, 1.0),
    (0.4, 0.3), (0.4, 0.6), (0.7, 0.3), (0.7, 0.6),
    (0.4, 0.85), (0.7, 0.15), (0.2, 0.3), (0.9, 0.6),
    (0.1, 0.1), (0.25, 0.5), (0.33, 0.77), (0.5, 0.25),
    (0.55, 0.9), (0.68, 0.42), (0.81, 0.63), (0.95, 0.05),
]
U_VALS = np.array([u for u, _ in UV_PAIRS], dtype=np.float64)
V_VALS = np.array([v for _, v in UV_PAIRS], dtype=np.float64)

# --- fixed test curve: degree 3, 7 control points ---------------------------------------------
CRV_P = 3
CRV_KNOTS = [0.0, 0.0, 0.0, 0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 1.0, 1.0]  # 7 + 3 + 1 = 11
CRV_POLES = np.array(
    [[i * 0.7, math.sin(1.1 * i), 0.3 * i - 0.05 * i * i] for i in range(7)],
    dtype=np.float64,
)
CRV_PARAMS = np.array(
    [0.0, 0.05, 0.13, 0.25, 0.31, 0.42, 0.5, 0.57, 0.66, 0.75, 0.81, 0.9, 0.97, 1.0],
    dtype=np.float64,
)

# --- fixed clustered parameters for averaging placement (sorted, in [0, 1], 25 values) --------
PARAMS_25 = [
    0.0, 0.01, 0.02, 0.03, 0.05, 0.07, 0.09, 0.12, 0.30, 0.31,
    0.32, 0.33, 0.34, 0.36, 0.38, 0.55, 0.56, 0.58, 0.80, 0.82,
    0.85, 0.90, 0.94, 0.98, 1.0,
]


# --- helpers (test_basis.py / test_eval.py conventions) ---------------------------------------


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


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
    return np.array(pts)


def _curve_points(poles: np.ndarray, degree: int, flat_knots, params: np.ndarray) -> np.ndarray:
    """Independent curve evaluation: scipy BSpline over each coordinate (test-only oracle)."""
    spl = ScipyBSpline(np.asarray(flat_knots, dtype=np.float64), np.asarray(poles), degree)
    return spl(params)


def _schema_surface() -> NurbsSurface:
    """A small VALIDATED NurbsSurface whose flat expansion is exactly U_KNOTS/V_KNOTS."""
    return NurbsSurface(
        poles=POLES.tolist(),
        weights=[],
        u_knots=U_COMPACT[0],
        u_mults=U_COMPACT[1],
        v_knots=V_COMPACT[0],
        v_mults=V_COMPACT[1],
        u_degree=P_U,
        v_degree=Q_V,
    )


def _geomdl_bspline_surface() -> BSpline.Surface:
    surf = BSpline.Surface()
    surf.degree_u = P_U
    surf.degree_v = Q_V
    # geomdl flat ordering is u-major (index i*NV + j) — same as test_eval.py
    surf.set_ctrlpts(POLES.reshape(-1, 3).tolist(), NU, NV)
    surf.knotvector_u = U_KNOTS
    surf.knotvector_v = V_KNOTS
    return surf


def _geomdl_nurbs_surface() -> NURBS.Surface:
    surf = NURBS.Surface()
    surf.degree_u = P_U
    surf.degree_v = Q_V
    ctrlptsw = np.concatenate([POLES * WEIGHTS[..., None], WEIGHTS[..., None]], axis=-1)
    surf.set_ctrlpts(ctrlptsw.reshape(-1, 4).tolist(), NU, NV)
    surf.knotvector_u = U_KNOTS
    surf.knotvector_v = V_KNOTS
    return surf


def _lift(poles: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Homogeneous lift [P * w, w] — the rational-surface convention under test."""
    return np.concatenate([poles * weights[..., None], weights[..., None]], axis=-1)


# --- clamped_uniform ---------------------------------------------------------------------------


def test_clamped_uniform_cubic():
    knots = clamped_uniform(6, 3)
    assert isinstance(knots, list)
    assert len(knots) == 6 + 3 + 1
    expected = [0.0, 0.0, 0.0, 0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0, 1.0, 1.0, 1.0]
    np.testing.assert_allclose(knots, expected, rtol=0.0, atol=1e-15)


def test_clamped_uniform_bezier_degenerate():
    # n_ctrl == degree + 1: no interior knots — the Bezier vector
    assert clamped_uniform(4, 3) == [0.0] * 4 + [1.0] * 4


def test_clamped_uniform_rejects_too_few_control_points():
    with pytest.raises(ValueError, match="n_ctrl"):
        clamped_uniform(3, 3)


# --- compact <-> flat conversion (§6.2 invariant 5 — THE interop footgun) ----------------------


def test_compact_to_flat_agrees_with_schema_reference():
    surf = _schema_surface()  # validated fixture: pydantic invariants all pass
    assert compact_to_flat(surf.u_knots, surf.u_mults) == surf.flat_u_knots() == U_KNOTS
    assert compact_to_flat(surf.v_knots, surf.v_mults) == surf.flat_v_knots() == V_KNOTS


def test_flat_to_compact_agrees_with_schema_fixture():
    surf = _schema_surface()
    assert flat_to_compact(surf.flat_u_knots()) == (surf.u_knots, surf.u_mults)
    assert flat_to_compact(surf.flat_v_knots()) == (surf.v_knots, surf.v_mults)


@pytest.mark.parametrize(
    "flat",
    [
        U_KNOTS,
        V_KNOTS,
        [0.0, 0.0, 0.0, 0.0, 0.3, 0.5, 0.5, 0.7, 1.0, 1.0, 1.0, 1.0],  # interior mult 2
        [0.0, 0.0, 1.0, 1.0],  # minimal degree-1 clamped
    ],
    ids=["u8", "v10", "mult2", "minimal"],
)
def test_flat_compact_roundtrip_exact(flat):
    knots, mults = flat_to_compact(flat)
    assert compact_to_flat(knots, mults) == flat  # EXACT round-trip, not approximate
    assert sum(mults) == len(flat)


def test_compact_flat_roundtrip_other_way():
    for knots, mults in (U_COMPACT, V_COMPACT, ([0.0, 0.5, 1.0], [4, 2, 4])):
        flat = compact_to_flat(knots, mults)
        assert flat_to_compact(flat) == (knots, mults)


def test_flat_to_compact_groups_values_within_tol():
    flat = [0.0, 0.0, 0.0, 0.5, 0.5 + 1e-12, 1.0, 1.0, 1.0]
    knots, mults = flat_to_compact(flat, tol=1e-9)
    assert knots == [0.0, 0.5, 1.0]
    assert mults == [3, 2, 3]


def test_flat_to_compact_rejects_decreasing_input():
    with pytest.raises(ValueError, match="non-decreasing"):
        flat_to_compact([0.0, 0.0, 0.6, 0.4, 1.0, 1.0])


def test_compact_to_flat_rejects_mismatched_lengths():
    with pytest.raises(ValueError, match="length"):
        compact_to_flat([0.0, 1.0], [3, 1, 3])


# --- averaging_knots (Eqs. 9.68/9.69) ----------------------------------------------------------


@pytest.mark.parametrize(("n_ctrl", "degree"), [(8, 3), (7, 2), (10, 3)])
def test_averaging_knots_properties(n_ctrl, degree):
    knots = averaging_knots(PARAMS_25, n_ctrl, degree)
    p, n = degree, n_ctrl - 1
    assert isinstance(knots, list)
    assert len(knots) == n_ctrl + p + 1
    # clamped ends on [0, 1]
    assert knots[: p + 1] == [0.0] * (p + 1)
    assert knots[-(p + 1):] == [1.0] * (p + 1)
    # interior strictly increasing, strictly inside (0, 1)
    interior = knots[p + 1: n_ctrl]
    assert all(0.0 < t < 1.0 for t in interior)
    assert all(b > a for a, b in zip(knots[p: n + 1], knots[p + 1: n + 2]))
    # Schoenberg–Whitney: every span [t_i, t_{i+1}) for p <= i <= n contains >= 1 parameter
    # (the last span is closed on the right so u == 1.0 counts)
    params = np.asarray(PARAMS_25)
    for i in range(p, n + 1):
        lo, hi = knots[i], knots[i + 1]
        inside = (params >= lo) & ((params < hi) | ((i == n) & (params <= hi)))
        assert inside.any(), f"span [{lo}, {hi}) (i={i}) contains no parameter"


def test_averaging_knots_matches_textbook_formula():
    # n_ctrl=8, p=3 over 25 params: d = 25/5 = 5, i = floor(j*5), alpha = 0
    # => interior knots are exactly params[4], params[9], params[14], params[19] (Eq. 9.69)
    knots = averaging_knots(PARAMS_25, 8, 3)
    expected_interior = [PARAMS_25[4], PARAMS_25[9], PARAMS_25[14], PARAMS_25[19]]
    np.testing.assert_allclose(knots[4:8], expected_interior, rtol=0.0, atol=1e-15)


def test_averaging_knots_accepts_numpy_input():
    as_list = averaging_knots(PARAMS_25, 8, 3)
    as_array = averaging_knots(np.asarray(PARAMS_25), 8, 3)
    assert as_list == as_array


def test_averaging_knots_rejects_too_few_params():
    with pytest.raises(ValueError, match="param"):
        averaging_knots([0.0, 0.5, 1.0], 8, 3)


def test_averaging_knots_rejects_over_clustered_params():
    # 11 identical params at 0 plus a lone 1.0: Eq. 9.68/9.69 averaging maps every
    # interior knot back onto 0.0, so the first interior knot equals the clamped
    # start (knots[p] == knots[p+1] == 0.0) — a non-increasing knot vector. These
    # pass every earlier guard (len 12 >= n_ctrl, sorted, within [0, 1]).
    clustered = [0.0] * 11 + [1.0]
    with pytest.raises(ValueError, match="non-increasing knots"):
        averaging_knots(clustered, 11, 3)


# --- A5.1: curve knot insertion — geomdl parity + invariance -----------------------------------


def test_insert_knot_curve_matches_geomdl():
    new_poles, new_knots = insert_knot_curve(CRV_POLES, CRV_P, CRV_KNOTS, 0.35, times=2)
    crv = BSpline.Curve()
    crv.degree = CRV_P
    crv.ctrlpts = CRV_POLES.tolist()
    crv.knotvector = CRV_KNOTS
    operations.insert_knot(crv, [0.35], [2])
    assert isinstance(new_knots, list)
    np.testing.assert_allclose(new_knots, crv.knotvector, rtol=0.0, atol=1e-15)
    np.testing.assert_allclose(new_poles, np.array(crv.ctrlpts), rtol=0.0, atol=1e-10)


def test_insert_knot_curve_leaves_curve_points_invariant():
    before = _curve_points(CRV_POLES, CRV_P, CRV_KNOTS, CRV_PARAMS)
    poles1, knots1 = insert_knot_curve(CRV_POLES, CRV_P, CRV_KNOTS, 0.35, times=1)
    poles2, knots2 = insert_knot_curve(poles1, CRV_P, knots1, 0.6, times=2)
    assert len(knots2) == len(CRV_KNOTS) + 3
    assert poles2.shape == (CRV_POLES.shape[0] + 3, 3)
    after = _curve_points(poles2, CRV_P, knots2, CRV_PARAMS)
    np.testing.assert_allclose(after, before, rtol=0.0, atol=1e-10)


def test_insert_knot_curve_existing_knot_up_to_degree():
    # 0.5 already has multiplicity 1; degree 3 allows 2 more insertions (mult == degree)
    before = _curve_points(CRV_POLES, CRV_P, CRV_KNOTS, CRV_PARAMS)
    poles, knots = insert_knot_curve(CRV_POLES, CRV_P, CRV_KNOTS, 0.5, times=2)
    assert knots.count(0.5) == 3
    np.testing.assert_allclose(_curve_points(poles, CRV_P, knots, CRV_PARAMS), before, rtol=0.0, atol=1e-10)


def test_insert_knot_curve_beyond_degree_raises():
    with pytest.raises(ValueError, match="multiplicity"):
        insert_knot_curve(CRV_POLES, CRV_P, CRV_KNOTS, 0.5, times=3)  # 1 + 3 > degree 3


def test_insert_knot_curve_outside_domain_raises():
    with pytest.raises(ValueError, match="domain"):
        insert_knot_curve(CRV_POLES, CRV_P, CRV_KNOTS, 0.0, times=1)
    with pytest.raises(ValueError, match="domain"):
        insert_knot_curve(CRV_POLES, CRV_P, CRV_KNOTS, 1.5, times=1)


# --- A5.3: surface knot insertion — geomdl parity ----------------------------------------------


@pytest.mark.parametrize(
    ("direction", "value", "geomdl_param", "geomdl_num"),
    [("u", 0.55, [0.55, None], [1, 0]), ("v", 0.45, [None, 0.45], [0, 1])],
    ids=["u", "v"],
)
def test_insert_knot_surface_matches_geomdl_bspline(direction, value, geomdl_param, geomdl_num):
    poles, weights, u_flat, v_flat = insert_knot_surface(
        POLES, None, P_U, Q_V, U_KNOTS, V_KNOTS, direction, value, times=1
    )
    assert weights is None
    surf = _geomdl_bspline_surface()
    operations.insert_knot(surf, geomdl_param, geomdl_num)
    np.testing.assert_allclose(u_flat, surf.knotvector_u, rtol=0.0, atol=1e-15)
    np.testing.assert_allclose(v_flat, surf.knotvector_v, rtol=0.0, atol=1e-15)
    expected = np.array(surf.ctrlpts).reshape(surf.ctrlpts_size_u, surf.ctrlpts_size_v, 3)
    assert poles.shape == expected.shape
    np.testing.assert_allclose(poles, expected, rtol=0.0, atol=1e-10)


@pytest.mark.parametrize(
    ("direction", "value", "geomdl_param", "geomdl_num"),
    [("u", 0.55, [0.55, None], [1, 0]), ("v", 0.45, [None, 0.45], [0, 1])],
    ids=["u", "v"],
)
def test_insert_knot_surface_matches_geomdl_nurbs(direction, value, geomdl_param, geomdl_num):
    poles, weights, u_flat, v_flat = insert_knot_surface(
        POLES, WEIGHTS, P_U, Q_V, U_KNOTS, V_KNOTS, direction, value, times=1
    )
    surf = _geomdl_nurbs_surface()
    operations.insert_knot(surf, geomdl_param, geomdl_num)
    np.testing.assert_allclose(u_flat, surf.knotvector_u, rtol=0.0, atol=1e-15)
    np.testing.assert_allclose(v_flat, surf.knotvector_v, rtol=0.0, atol=1e-15)
    # geomdl NURBS ctrlptsw is the homogeneous [x*w, y*w, z*w, w] grid (u-major)
    expected_w = np.array(surf.ctrlptsw).reshape(surf.ctrlpts_size_u, surf.ctrlpts_size_v, 4)
    np.testing.assert_allclose(_lift(poles, weights), expected_w, rtol=0.0, atol=1e-10)


# --- THE INVARIANCE TESTS: insertion/refinement must not move the surface ----------------------


@pytest.mark.parametrize("weights", [None, WEIGHTS], ids=["bspline", "nurbs"])
@pytest.mark.parametrize(("direction", "value"), [("u", 0.55), ("v", 0.45)], ids=["u", "v"])
def test_insert_knot_surface_eval_invariant(weights, direction, value):
    before = _eval64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    poles, w, u_flat, v_flat = insert_knot_surface(
        POLES, weights, P_U, Q_V, U_KNOTS, V_KNOTS, direction, value, times=1
    )
    after = _eval64(poles, w, u_flat, v_flat, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(after, before, rtol=0.0, atol=1e-10)


@pytest.mark.parametrize("weights", [None, WEIGHTS], ids=["bspline", "nurbs"])
def test_insert_existing_knot_to_degree_multiplicity_stays_invariant(weights):
    before = _eval64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    # u = 0.4 exists with mult 1, degree 2: one more insertion reaches mult == degree
    poles, w, u_flat, v_flat = insert_knot_surface(
        POLES, weights, P_U, Q_V, U_KNOTS, V_KNOTS, "u", 0.4, times=1
    )
    assert u_flat.count(0.4) == 2
    # v = 0.3 exists with mult 1, degree 3: two more insertions reach mult == degree
    poles, w, u_flat, v_flat = insert_knot_surface(
        poles, w, P_U, Q_V, u_flat, v_flat, "v", 0.3, times=2
    )
    assert v_flat.count(0.3) == 3
    after = _eval64(poles, w, u_flat, v_flat, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(after, before, rtol=0.0, atol=1e-10)


@pytest.mark.parametrize(
    ("direction", "value", "times"),
    [("u", 0.4, 2), ("v", 0.3, 3), ("u", 0.55, 3)],
    ids=["u-existing", "v-existing", "u-new"],
)
def test_insert_knot_surface_beyond_degree_raises(direction, value, times):
    with pytest.raises(ValueError, match="multiplicity"):
        insert_knot_surface(POLES, WEIGHTS, P_U, Q_V, U_KNOTS, V_KNOTS, direction, value, times=times)


def test_insert_knot_surface_rejects_bad_direction():
    with pytest.raises(ValueError, match="direction"):
        insert_knot_surface(POLES, None, P_U, Q_V, U_KNOTS, V_KNOTS, "w", 0.5)


# --- A5.4: curve knot refinement ----------------------------------------------------------------


def test_refine_knots_curve_equals_sequential_insertion():
    new = [0.2, 0.35, 0.35, 0.6]  # includes a doubled new knot
    ref_poles, ref_knots = refine_knots_curve(CRV_POLES, CRV_P, CRV_KNOTS, new)
    seq_poles, seq_knots = insert_knot_curve(CRV_POLES, CRV_P, CRV_KNOTS, 0.2, times=1)
    seq_poles, seq_knots = insert_knot_curve(seq_poles, CRV_P, seq_knots, 0.35, times=2)
    seq_poles, seq_knots = insert_knot_curve(seq_poles, CRV_P, seq_knots, 0.6, times=1)
    np.testing.assert_allclose(ref_knots, seq_knots, rtol=0.0, atol=1e-15)
    np.testing.assert_allclose(ref_poles, seq_poles, rtol=0.0, atol=1e-12)


def test_refine_knots_curve_invariance():
    before = _curve_points(CRV_POLES, CRV_P, CRV_KNOTS, CRV_PARAMS)
    poles, knots = refine_knots_curve(CRV_POLES, CRV_P, CRV_KNOTS, [0.1, 0.35, 0.9])
    assert len(knots) == len(CRV_KNOTS) + 3
    assert poles.shape == (CRV_POLES.shape[0] + 3, 3)
    assert knots == sorted(knots)
    after = _curve_points(poles, CRV_P, knots, CRV_PARAMS)
    np.testing.assert_allclose(after, before, rtol=0.0, atol=1e-10)


def test_refine_knots_curve_empty_is_identity():
    poles, knots = refine_knots_curve(CRV_POLES, CRV_P, CRV_KNOTS, [])
    assert knots == CRV_KNOTS
    np.testing.assert_allclose(poles, CRV_POLES, rtol=0.0, atol=0.0)


def test_refine_knots_curve_beyond_degree_raises():
    # 0.5 exists with mult 1; adding it 3 more times exceeds degree 3
    with pytest.raises(ValueError, match="multiplicity"):
        refine_knots_curve(CRV_POLES, CRV_P, CRV_KNOTS, [0.5, 0.5, 0.5])


def test_refine_knots_curve_rejects_unsorted():
    with pytest.raises(ValueError, match="ascending"):
        refine_knots_curve(CRV_POLES, CRV_P, CRV_KNOTS, [0.6, 0.2])


# --- A5.5: surface knot refinement — 3 new knots, eval-invariant --------------------------------


@pytest.mark.parametrize("weights", [None, WEIGHTS], ids=["bspline", "nurbs"])
@pytest.mark.parametrize(
    ("direction", "new_knots"),
    [("u", [0.2, 0.55, 0.9]), ("v", [0.15, 0.45, 0.8])],
    ids=["u", "v"],
)
def test_refine_knots_surface_eval_invariant(weights, direction, new_knots):
    before = _eval64(POLES, weights, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    poles, w, u_flat, v_flat = refine_knots_surface(
        POLES, weights, P_U, Q_V, U_KNOTS, V_KNOTS, direction, new_knots
    )
    if direction == "u":
        assert len(u_flat) == len(U_KNOTS) + 3 and v_flat == V_KNOTS
        assert poles.shape == (NU + 3, NV, 3)
    else:
        assert len(v_flat) == len(V_KNOTS) + 3 and u_flat == U_KNOTS
        assert poles.shape == (NU, NV + 3, 3)
    if weights is None:
        assert w is None
    else:
        assert w.shape == poles.shape[:2]
        assert np.all(w > 0.0)
    after = _eval64(poles, w, u_flat, v_flat, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(after, before, rtol=0.0, atol=1e-10)


def test_refine_knots_surface_both_directions_chained_invariant():
    before = _eval64(POLES, WEIGHTS, U_KNOTS, V_KNOTS, P_U, Q_V, U_VALS, V_VALS)
    poles, w, u_flat, v_flat = refine_knots_surface(
        POLES, WEIGHTS, P_U, Q_V, U_KNOTS, V_KNOTS, "u", [0.2, 0.55, 0.9]
    )
    poles, w, u_flat, v_flat = refine_knots_surface(
        poles, w, P_U, Q_V, u_flat, v_flat, "v", [0.15, 0.45, 0.8]
    )
    after = _eval64(poles, w, u_flat, v_flat, P_U, Q_V, U_VALS, V_VALS)
    np.testing.assert_allclose(after, before, rtol=0.0, atol=1e-10)


def test_refine_knots_surface_beyond_degree_raises():
    # u = 0.4 exists with mult 1, degree 2: two more copies exceed the degree
    with pytest.raises(ValueError, match="multiplicity"):
        refine_knots_surface(POLES, WEIGHTS, P_U, Q_V, U_KNOTS, V_KNOTS, "u", [0.4, 0.4])
