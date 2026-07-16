"""U1.1 — oracle-parity tests for the MLX B-spline basis core (`app/core/basis.py`).

Oracles (test-only, never imported by app/ code — SPEC-12 licensing rule):
  * geomdl.helpers.find_span_linear / basis_function / basis_function_ders (Piegl & Tiller
    A2.1/A2.2/A2.3 — the same normative algorithms, MIT).
  * scipy.interpolate.BSpline.design_matrix (independent non-rational cross-check).

Everything is deterministic: fixed hand-written knot vectors (flat/textbook form, clamped,
non-uniform, with interior knots incl. multiplicity 2) and a fixed parameter list covering
interior values, the knot values themselves, u = 0.0 and u = 1.0. No RNG anywhere.

Tolerances per SPEC-12 §5.3 / D-9 two-precision policy: 1e-10 in float64 on the CPU stream,
1e-4 partition-of-unity sanity in float32 on the default (GPU) stream.
"""

import mlx.core as mx
import numpy as np
import pytest
from geomdl import helpers
from scipy.interpolate import BSpline

from app.core.basis import basis_funs, ders_basis_funs, find_span

# --- fixed, hand-written clamped non-uniform knot vectors (flat/textbook form) -------------
# degree -> flat knot vector; every vector is clamped (p+1 end multiplicities) and has
# interior knots, including a multiplicity-2 interior knot at 0.5.
KNOTS = {
    2: [0.0, 0.0, 0.0, 0.2, 0.5, 0.5, 0.8, 1.0, 1.0, 1.0],
    3: [0.0, 0.0, 0.0, 0.0, 0.3, 0.5, 0.5, 0.7, 1.0, 1.0, 1.0, 1.0],
    5: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.5, 0.5, 0.8, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
}
DEGREES = sorted(KNOTS)

# >= 15 deterministic parameters: interior values, the knot values themselves (0.2, 0.3,
# 0.5, 0.7, 0.8 across the three vectors), and both curve ends.
PARAMS = [
    0.0, 0.03, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45,
    0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 0.97, 1.0,
]


def _n(p: int, knots: list[float]) -> int:
    """Last control-point index: n = m - p - 2 with m = len(knots) - 1 (The NURBS Book)."""
    return len(knots) - p - 2


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


def _spans_np(p: int, knots: list[float], u64: mx.array) -> np.ndarray:
    spans = find_span(_n(p, knots), p, u64, _mx64(knots))
    return np.array(spans)


# --- A2.1 find_span ------------------------------------------------------------------------


@pytest.mark.parametrize("p", DEGREES)
def test_find_span_matches_geomdl(p):
    knots = KNOTS[p]
    n = _n(p, knots)
    ours = _spans_np(p, knots, _mx64(PARAMS))
    expected = [helpers.find_span_linear(p, knots, n + 1, u) for u in PARAMS]
    assert ours.tolist() == expected


@pytest.mark.parametrize("p", DEGREES)
def test_find_span_range_and_curve_end(p):
    knots = KNOTS[p]
    n = _n(p, knots)
    spans = _spans_np(p, knots, _mx64(PARAMS))
    assert int(spans.min()) >= p
    assert int(spans.max()) <= n
    # u == knots[n+1] (the curve end) must return n, the last valid span (A2.1 edge case).
    end = _spans_np(p, knots, _mx64([knots[n + 1]]))
    assert end.tolist() == [n]
    # u == 0.0 (the curve start) sits in the first valid span p.
    start = _spans_np(p, knots, _mx64([0.0]))
    assert start.tolist() == [p]


def test_find_span_accepts_any_shape():
    p = 3
    knots = KNOTS[p]
    u = _mx64(np.asarray(PARAMS, dtype=np.float64).reshape(4, 5))
    spans = find_span(_n(p, knots), p, u, _mx64(knots))
    assert spans.shape == (4, 5)
    flat = _spans_np(p, knots, _mx64(PARAMS))
    assert np.array(spans).reshape(-1).tolist() == flat.tolist()


# --- A2.2 basis_funs -----------------------------------------------------------------------


@pytest.mark.parametrize("p", DEGREES)
def test_basis_funs_matches_geomdl(p):
    knots = KNOTS[p]
    u64 = _mx64(PARAMS)
    kv = _mx64(knots)
    spans = find_span(_n(p, knots), p, u64, kv)
    ours = np.array(basis_funs(spans, u64, p, kv))
    assert ours.shape == (len(PARAMS), p + 1)
    for i, u in enumerate(PARAMS):
        span = int(np.array(spans)[i])
        expected = helpers.basis_function(p, knots, span, u)
        np.testing.assert_allclose(ours[i], expected, rtol=0.0, atol=1e-10)


@pytest.mark.parametrize("p", DEGREES)
def test_basis_matches_scipy_design_matrix(p):
    knots = KNOTS[p]
    n = _n(p, knots)
    u64 = _mx64(PARAMS)
    kv = _mx64(knots)
    spans_np = _spans_np(p, knots, u64)
    basis_np = np.array(basis_funs(mx.array(spans_np), u64, p, kv))
    # place the p+1 nonzero values at columns span-p .. span of a dense (m, n+1) matrix
    dense = np.zeros((len(PARAMS), n + 1), dtype=np.float64)
    for i, span in enumerate(spans_np):
        dense[i, span - p : span + 1] = basis_np[i]
    expected = BSpline.design_matrix(
        np.asarray(PARAMS, dtype=np.float64), np.asarray(knots, dtype=np.float64), p
    ).toarray()
    np.testing.assert_allclose(dense, expected, rtol=0.0, atol=1e-10)


@pytest.mark.parametrize("p", DEGREES)
def test_partition_of_unity_f64(p):
    knots = KNOTS[p]
    u64 = _mx64(PARAMS)
    kv = _mx64(knots)
    spans = find_span(_n(p, knots), p, u64, kv)
    sums = np.array(mx.sum(basis_funs(spans, u64, p, kv), axis=-1, stream=mx.cpu))
    np.testing.assert_allclose(sums, np.ones(len(PARAMS)), rtol=0.0, atol=1e-10)


@pytest.mark.parametrize("p", DEGREES)
def test_partition_of_unity_f32_default_stream(p):
    knots = KNOTS[p]
    u32 = mx.array(np.asarray(PARAMS, dtype=np.float32))
    kv32 = mx.array(np.asarray(knots, dtype=np.float32))
    spans = find_span(_n(p, knots), p, u32, kv32)
    # spans must agree with the float64 lookup (same decimals -> same f32 values -> same >=)
    assert np.array(spans).tolist() == _spans_np(p, knots, _mx64(PARAMS)).tolist()
    values = basis_funs(spans, u32, p, kv32)
    assert values.dtype == mx.float32
    sums = np.array(mx.sum(values, axis=-1))
    np.testing.assert_allclose(sums, np.ones(len(PARAMS), dtype=np.float32), rtol=0.0, atol=1e-4)


@pytest.mark.parametrize("p", DEGREES)
def test_end_conditions(p):
    knots = KNOTS[p]
    u64 = _mx64([0.0, 1.0])
    kv = _mx64(knots)
    spans = find_span(_n(p, knots), p, u64, kv)
    values = np.array(basis_funs(spans, u64, p, kv))
    # clamped ends: at u=0 the first nonzero basis value is 1, at u=1 the last is 1
    np.testing.assert_allclose(values[0, 0], 1.0, rtol=0.0, atol=1e-10)
    np.testing.assert_allclose(values[0, 1:], 0.0, rtol=0.0, atol=1e-10)
    np.testing.assert_allclose(values[1, -1], 1.0, rtol=0.0, atol=1e-10)
    np.testing.assert_allclose(values[1, :-1], 0.0, rtol=0.0, atol=1e-10)


def test_basis_funs_accepts_any_shape():
    p = 3
    knots = KNOTS[p]
    kv = _mx64(knots)
    u = _mx64(np.asarray(PARAMS, dtype=np.float64).reshape(2, 2, 5))
    spans = find_span(_n(p, knots), p, u, kv)
    values = basis_funs(spans, u, p, kv)
    assert values.shape == (2, 2, 5, p + 1)
    flat_spans = find_span(_n(p, knots), p, _mx64(PARAMS), kv)
    flat = np.array(basis_funs(flat_spans, _mx64(PARAMS), p, kv))
    np.testing.assert_allclose(np.array(values).reshape(-1, p + 1), flat, rtol=0.0, atol=0.0)


# --- A2.3 ders_basis_funs ------------------------------------------------------------------


@pytest.mark.parametrize("p", DEGREES)
@pytest.mark.parametrize("k", [0, 1, 2])
def test_ders_matches_geomdl(p, k):
    knots = KNOTS[p]
    u64 = _mx64(PARAMS)
    kv = _mx64(knots)
    spans = find_span(_n(p, knots), p, u64, kv)
    ours = np.array(ders_basis_funs(spans, u64, p, kv, k))
    assert ours.shape == (len(PARAMS), k + 1, p + 1)
    for i, u in enumerate(PARAMS):
        span = int(np.array(spans)[i])
        expected = helpers.basis_function_ders(p, knots, span, u, k)
        np.testing.assert_allclose(ours[i], expected, rtol=0.0, atol=1e-10)


@pytest.mark.parametrize("p", [p for p in DEGREES if p >= 3])
def test_ders_order3_matches_geomdl(p):
    """k=3 parity against geomdl (order 3) on the degree-3 and degree-5 fixtures, proving the
    ``ders_basis_funs`` "any k >= 0 works" docstring beyond the k <= 2 SPEC-12 requirement.
    (geomdl's ``basis_function_ders`` raises IndexError for order > degree, so k=3 is exercised
    only on degrees >= 3; our own k > p case is covered by returning zeros — see order-0/end tests.)
    """
    knots = KNOTS[p]
    u64 = _mx64(PARAMS)
    kv = _mx64(knots)
    spans = find_span(_n(p, knots), p, u64, kv)
    ours = np.array(ders_basis_funs(spans, u64, p, kv, 3))
    assert ours.shape == (len(PARAMS), 4, p + 1)
    for i, u in enumerate(PARAMS):
        span = int(np.array(spans)[i])
        expected = helpers.basis_function_ders(p, knots, span, u, 3)
        np.testing.assert_allclose(ours[i], expected, rtol=0.0, atol=1e-10)


@pytest.mark.parametrize("p", DEGREES)
def test_ders_order0_equals_basis_funs(p):
    knots = KNOTS[p]
    u64 = _mx64(PARAMS)
    kv = _mx64(knots)
    spans = find_span(_n(p, knots), p, u64, kv)
    ders = np.array(ders_basis_funs(spans, u64, p, kv, 2))
    values = np.array(basis_funs(spans, u64, p, kv))
    np.testing.assert_allclose(ders[:, 0, :], values, rtol=0.0, atol=1e-12)


@pytest.mark.parametrize("p", DEGREES)
def test_first_derivative_sums_to_zero(p):
    knots = KNOTS[p]
    u64 = _mx64(PARAMS)
    kv = _mx64(knots)
    spans = find_span(_n(p, knots), p, u64, kv)
    ders = np.array(ders_basis_funs(spans, u64, p, kv, 1))
    np.testing.assert_allclose(ders[:, 1, :].sum(axis=-1), 0.0, rtol=0.0, atol=1e-8)


def test_ders_accepts_any_shape():
    p = 3
    knots = KNOTS[p]
    kv = _mx64(knots)
    u = _mx64(np.asarray(PARAMS, dtype=np.float64).reshape(5, 4))
    spans = find_span(_n(p, knots), p, u, kv)
    ders = ders_basis_funs(spans, u, p, kv, 2)
    assert ders.shape == (5, 4, 3, p + 1)
    flat_spans = find_span(_n(p, knots), p, _mx64(PARAMS), kv)
    flat = np.array(ders_basis_funs(flat_spans, _mx64(PARAMS), p, kv, 2))
    np.testing.assert_allclose(np.array(ders).reshape(-1, 3, p + 1), flat, rtol=0.0, atol=0.0)
