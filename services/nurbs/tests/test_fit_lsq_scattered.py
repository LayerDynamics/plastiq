"""U3.2 — tests for the scattered-data least-squares B-spline fit (`app/core/fit_lsq.py`).

The scattered path solves the FULL normal equations over every control point at once
(SPEC-12 §5.4-3)::

    (BᵀB + λ·LᵀL) P = BᵀQ

with ``B`` the 2-D tensor-product design matrix (`app.core.eval.design_matrix`, column
layout ``i*nv + j``), ``L`` the control-net *umbrella* Laplacian, and boundary control-net
rows optionally pinned by ELIMINATION to given 3-D rim-curve control points (the U7.2
shared-boundary mechanism). Solved via Cholesky on the float64 CPU stream (D-9).

Knot vectors are ``clamped_uniform`` (data-independent) — see the ``fit_scattered``
docstring for why that, not ``averaging_knots``, is the correct choice for scattered data
with fairness and for U7.2 watertight-by-construction shared edges.

Deterministic: NO RNG anywhere. Scattered ``uv`` samples come from a jittered lattice whose
jitter is a fixed sinusoid, so identical inputs give bitwise-identical fits.
"""

import math

import mlx.core as mx
import numpy as np
import pytest

from app.core.eval import design_matrix, surface_point
from app.core.fit_lsq import (
    ScatteredFit,
    _chol_solve,
    _control_net_laplacian,
    fit_scattered,
)
from app.core.knots import clamped_uniform
from app.core.params import deviation

P = Q = 3


# --- helpers ------------------------------------------------------------------------------------


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


def _np(a) -> np.ndarray:
    return np.array(a)


def _scatter_uv(k: int) -> np.ndarray:
    """A deterministic irregular ``(k*k, 2)`` set of (u, v) in [0, 1]² — a jittered lattice.

    The jitter is a fixed sinusoid of the lattice indices (NO RNG, FR-6/D-10). The base
    lattice includes 0 and 1 in each direction, so the perimeter is well covered.
    """
    ii, jj = np.meshgrid(np.arange(k), np.arange(k), indexing="ij")
    base_u = ii / (k - 1)
    base_v = jj / (k - 1)
    jitter = 0.35 / (k - 1)
    u = np.clip(base_u + jitter * np.sin(4.0 * ii + 1.3 * jj), 0.0, 1.0)
    v = np.clip(base_v + jitter * np.cos(2.0 * ii + 3.1 * jj), 0.0, 1.0)
    return np.stack([u.reshape(-1), v.reshape(-1)], axis=-1)


def _cap_xyz(uv: np.ndarray, radius: float = 2.0) -> np.ndarray:
    """A gentle spherical cap over [0, 1]²: xy = uv, z = sqrt(R² − (x−½)² − (y−½)²)."""
    x = uv[:, 0]
    y = uv[:, 1]
    z = np.sqrt(radius**2 - (x - 0.5) ** 2 - (y - 0.5) ** 2)
    return np.stack([x, y, z], axis=-1)


def _saddle_xyz(uv: np.ndarray) -> np.ndarray:
    """The hyperbolic-paraboloid saddle z = x·y over [0, 1]² (xy = uv)."""
    x = uv[:, 0]
    y = uv[:, 1]
    return np.stack([x, y, x * y], axis=-1)


def _dev(points: np.ndarray, fit: ScatteredFit) -> tuple[float, float]:
    """(rms, max) deviation of the data from the fitted surface via params.deviation."""
    return deviation(_mx64(points), fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q)


def _laplacian_energy(fit: ScatteredFit, lap: np.ndarray) -> float:
    """Σ‖L P‖² — the control-net Laplacian (fairness) energy of a fitted net."""
    poles = _np(fit.poles).reshape(-1, 3)
    lp = lap @ poles
    return float(np.sum(lp * lp))


# --- return shape / type ------------------------------------------------------------------------


def test_fit_scattered_returns_evaluatable_scatteredfit():
    uv = _scatter_uv(16)
    fit = fit_scattered(_mx64(_cap_xyz(uv)), _mx64(uv), P, Q, 10, 8)
    assert isinstance(fit, ScatteredFit)
    assert fit.p == P and fit.q == Q
    assert isinstance(fit.poles, mx.array) and fit.poles.dtype == mx.float64
    assert fit.poles.shape == (10, 8, 3)
    assert isinstance(fit.u_knots, mx.array) and fit.u_knots.dtype == mx.float64
    assert isinstance(fit.v_knots, mx.array) and fit.v_knots.dtype == mx.float64
    assert fit.u_knots.shape == (10 + P + 1,)  # knot-count law
    assert fit.v_knots.shape == (8 + Q + 1,)


# --- accuracy on analytic patches ---------------------------------------------------------------


def test_hemisphere_cap_deviation_below_target():
    uv = _scatter_uv(18)
    pts = _cap_xyz(uv)
    # tiny fairness so the accuracy is data-driven (λ biases the net off the exact solution)
    fit = fit_scattered(_mx64(pts), _mx64(uv), P, Q, 10, 10, fairness=1e-6)
    rms, mx_dev = _dev(pts, fit)
    assert mx_dev < 5e-3, mx_dev
    assert rms < mx_dev  # rms deviation is strictly below the worst-case max


def test_saddle_deviation_below_target():
    uv = _scatter_uv(18)
    pts = _saddle_xyz(uv)
    fit = fit_scattered(_mx64(pts), _mx64(uv), P, Q, 10, 10, fairness=1e-6)
    rms, mx_dev = _dev(pts, fit)
    assert mx_dev < 5e-3, mx_dev
    assert rms < mx_dev


# --- the normal matrix is SPD (BᵀB + λLᵀL) and Cholesky-solves exactly --------------------------


def test_normal_matrix_is_spd_and_chol_solve_is_exact():
    nu = nv = 10
    lam = 1e-3
    uv = _scatter_uv(18)
    u_knots = _mx64(clamped_uniform(nu, P))
    v_knots = _mx64(clamped_uniform(nv, Q))
    B = _np(design_matrix(_mx64(uv[:, 0]), _mx64(uv[:, 1]), u_knots, v_knots, P, Q, nu, nv))
    lap = _np(_control_net_laplacian(nu, nv))
    A = B.T @ B + lam * (lap.T @ lap)  # the exact matrix fit_scattered factors
    # symmetric + all eigenvalues strictly positive (SPD) — the design's core guarantee
    np.testing.assert_allclose(A, A.T, rtol=0.0, atol=1e-12)
    assert np.all(np.linalg.eigvalsh(A) > 0.0)
    # the real Cholesky path recovers a known solution: A x = A x_true
    n = nu * nv
    x_true = np.cos(np.arange(n, dtype=np.float64))[:, None] * np.array([[1.0, -2.0, 0.5]])
    rhs = _mx64(A @ x_true)
    x = _np(_chol_solve(_mx64(A), rhs))
    np.testing.assert_allclose(x, x_true, rtol=0.0, atol=1e-8)
    assert np.linalg.norm(A @ x - _np(rhs)) < 1e-8


# --- fairness fixes wrinkling on data-sparse regions --------------------------------------------


def _sparse_cap() -> tuple[np.ndarray, np.ndarray]:
    """A cap sampled with FEWER points (36) than the 10×10 = 100 control-net poles.

    With ``M = 36 < nu*nv = 100`` the design matrix has rank ≤ M, so ``BᵀB`` is genuinely
    rank-deficient — the "fewer samples than control points" data-sparse case (SPEC-12
    §5.4-3 / R-2). At λ = 0 the normal matrix is singular (Cholesky yields NaN); the umbrella
    Laplacian's λ·LᵀL term is exactly what restores an SPD, wrinkle-free fit.
    """
    uv = _scatter_uv(6)
    return _cap_xyz(uv), uv


def test_fairness_rescues_underdetermined_fit_and_keeps_accuracy():
    pts, uv = _sparse_cap()
    nu = nv = 10
    lap = _np(_control_net_laplacian(nu, nv))

    faired = fit_scattered(_mx64(pts), _mx64(uv), P, Q, nu, nv, fairness=1e-2)
    e_faired = _laplacian_energy(faired, lap)
    # LOAD-BEARING: with fairness the underdetermined fit is smooth AND accurate on the
    # samples (a looser bound than the dense accuracy tests — the point is it does not blow up)
    _, mx_dev = _dev(pts, faired)
    assert mx_dev < 5e-3, mx_dev
    assert np.isfinite(e_faired)

    # LOAD-BEARING (the task's explicit clause): among SPD (λ > 0) fits on the SAME sparse
    # data, MORE fairness STRICTLY reduces the control-net Laplacian energy Σ‖LP‖² (Tikhonov
    # monotonicity). Both solves are finite; the reduction is a measured strict inequality.
    e_low = _laplacian_energy(fit_scattered(_mx64(pts), _mx64(uv), P, Q, nu, nv, fairness=1e-6), lap)
    e_high = _laplacian_energy(fit_scattered(_mx64(pts), _mx64(uv), P, Q, nu, nv, fairness=1e-1), lap)
    assert e_high < e_faired < e_low, (e_high, e_faired, e_low)

    # And λ = 0 is genuinely ill-conditioned here (rank-deficient BᵀB): the solve is singular
    # (NaN) or wrinkles far past the faired net. Fairness fixes both — the design's raison
    # d'être for scattered data.
    try:
        wrinkled = fit_scattered(_mx64(pts), _mx64(uv), P, Q, nu, nv, fairness=0.0)
    except Exception:
        return  # a Cholesky failure at λ=0 IS the ill-conditioning this test asserts
    e_wrinkled = _laplacian_energy(wrinkled, lap)
    assert math.isnan(e_wrinkled) or e_wrinkled > 5.0 * e_faired, (e_wrinkled, e_faired)


# --- rim pinning: watertight-by-construction shared edge (the U7.2-critical property) -----------


def _rim_curve(nu: int) -> np.ndarray:
    """A fixed known 3-D rim-curve control polygon of ``nu`` points (NO RNG)."""
    t = np.linspace(0.0, 1.0, nu)
    return np.stack([t, np.zeros_like(t), 0.25 + 0.1 * np.sin(2.0 * math.pi * t)], axis=-1)


def test_rim_pinned_poles_are_exact_and_interior_still_fits():
    uv = _scatter_uv(18)
    pts = _cap_xyz(uv)
    nu = nv = 10
    curve = _rim_curve(nu)  # (nu, 3) — pin the v = 0 edge (poles[:, 0])
    fit = fit_scattered(_mx64(pts), _mx64(uv), P, Q, nu, nv, fairness=1e-3, rim={"v0": curve})
    # the pinned control-net row comes out EXACTLY equal to the supplied rim curve
    np.testing.assert_allclose(_np(fit.poles)[:, 0, :], curve, rtol=0.0, atol=1e-9)
    # the interior still fits the cap data (looser bound — the off-surface rim perturbs it)
    _, mx_dev = _dev(pts, fit)
    assert mx_dev < 2e-1, mx_dev


def test_two_adjacent_patches_share_the_pinned_edge_exactly():
    """U7.2: two patches pinned to the SAME rim curve evaluate identically along that edge.

    Patch A pins its v = 1 edge, patch B pins its v = 0 edge, both to the same curve C.
    Because clamped_uniform u-knots are data-independent (identical for both patches) and
    the edge is a clamped end, each patch's edge IS the B-spline curve with control polygon
    C on those u-knots — so the two evaluated edges coincide to solver precision. Watertight
    by construction, not by sew tolerance (SPEC-7 D-3's sagitta lesson).
    """
    nu = nv = 10
    curve = _rim_curve(nu)
    uv_a = _scatter_uv(18)
    fit_a = fit_scattered(_mx64(_cap_xyz(uv_a)), _mx64(uv_a), P, Q, nu, nv,
                          fairness=1e-3, rim={"v1": curve})
    uv_b = _scatter_uv(16)
    fit_b = fit_scattered(_mx64(_saddle_xyz(uv_b)), _mx64(uv_b), P, Q, nu, nv,
                          fairness=1e-3, rim={"v0": curve})
    # the shared-edge spline space is bitwise-identical between patches (data-independent
    # clamped_uniform knots). u is the seam-critical direction — both pin a v-edge, so the
    # edge curve is spanned by the u-knots — but v is identical here too. This is the
    # explicit knot-identity guarantee behind the 1e-9 edge coincidence asserted below.
    np.testing.assert_array_equal(_np(fit_a.u_knots), _np(fit_b.u_knots))
    np.testing.assert_array_equal(_np(fit_a.v_knots), _np(fit_b.v_knots))
    # both pinned rows are exactly the shared curve
    np.testing.assert_allclose(_np(fit_a.poles)[:, nv - 1, :], curve, rtol=0.0, atol=1e-9)
    np.testing.assert_allclose(_np(fit_b.poles)[:, 0, :], curve, rtol=0.0, atol=1e-9)
    # and the two surfaces coincide along the shared parameter line (A at v=1, B at v=0)
    us = _mx64(np.linspace(0.0, 1.0, 25))
    edge_a = _np(surface_point(fit_a.poles, None, fit_a.u_knots, fit_a.v_knots, P, Q,
                               us, _mx64(np.ones(25))))
    edge_b = _np(surface_point(fit_b.poles, None, fit_b.u_knots, fit_b.v_knots, P, Q,
                               us, _mx64(np.zeros(25))))
    np.testing.assert_allclose(edge_a, edge_b, rtol=0.0, atol=1e-9)


def test_rim_rejects_inconsistent_shared_corner():
    nu = nv = 8
    # v0 pins poles[:, 0] and u0 pins poles[0, :]; they share corner (0, 0). Conflicting.
    v0 = np.zeros((nu, 3))
    u0 = np.ones((nv, 3))  # u0[0] = (1,1,1) contradicts v0[0] = (0,0,0)
    with pytest.raises(ValueError, match="inconsistent"):
        fit_scattered(_mx64(_cap_xyz(_scatter_uv(12))), _mx64(_scatter_uv(12)),
                      P, Q, nu, nv, rim={"v0": v0, "u0": u0})


def test_all_edges_pinned_returns_exact_copy_without_solving():
    """When every pole is pinned, `_solve_pinned` copies the rim verbatim — no solve runs.

    A degree-1, 2×2 net has all four control points on the boundary, so pinning all four
    edges (u0, u1, v0, v1) pins every pole. `_solve_pinned` then hits its `free_idx.size==0`
    early return and copies the supplied values straight through. Building the four edges as
    slices of ONE target net auto-satisfies shared-corner consistency, and the bitwise-equal
    assertion is itself the proof the early return ran: the general Cholesky solve could not
    reproduce this arbitrary target net exactly, so any fall-through to the solve would fail.
    """
    nu = nv = 2
    p = q = 1
    # a target control net whose z is arbitrary and exactly float64-representable
    target = np.array(
        [[[0.0, 0.0, 0.0], [0.0, 1.0, 2.0]],
         [[1.0, 0.0, 3.0], [1.0, 1.0, 4.0]]],
        dtype=np.float64,
    )  # (nu, nv, 3)
    rim = {
        "u0": target[0, :, :],   # poles[0, :]   (nv, 3)
        "u1": target[nu - 1, :, :],  # poles[nu-1, :] (nv, 3)
        "v0": target[:, 0, :],   # poles[:, 0]   (nu, 3)
        "v1": target[:, nv - 1, :],  # poles[:, nv-1] (nu, 3)
    }
    uv = _scatter_uv(4)  # data is irrelevant — no solve happens — but must be a valid patch
    fit = fit_scattered(_mx64(_cap_xyz(uv)), _mx64(uv), p, q, nu, nv, rim=rim)
    # every returned pole is EXACTLY the supplied rim value (pure copy, no arithmetic)
    np.testing.assert_array_equal(_np(fit.poles), target)


def test_resolve_rim_validation_raises():
    """`_resolve_rim`'s guard branches each raise their specific ValueError.

    Uses nu != nv (6, 8) so the u0/u1 (expects `(nv, 3)`) and v0/v1 (expects `(nu, 3)`)
    shape checks discriminate an axis swap: each key is fed the OTHER axis's length, so a
    `(nv,3)`↔`(nu,3)` mix-up would surface as the wrong expected-tuple in the message.
    """
    nu, nv = 6, 8
    uv = _scatter_uv(10)
    pts = _cap_xyz(uv)

    def _fit(rim):
        return fit_scattered(_mx64(pts), _mx64(uv), P, Q, nu, nv, rim=rim)

    # (a) rim is not a dict
    with pytest.raises(ValueError, match=r"rim must be a dict"):
        _fit([("v0", np.zeros((nu, 3)))])
    # (b) unknown edge key
    with pytest.raises(ValueError, match=r"rim key must be one of"):
        _fit({"w0": np.zeros((nu, 3))})
    # (c) u0/u1 value must be (nv, 3) = (8, 3); feed the nu-length (6, 3) instead
    with pytest.raises(ValueError, match=r"rim\['u0'\] must have shape \(8, 3\)"):
        _fit({"u0": np.zeros((nu, 3))})
    # (d) v0/v1 value must be (nu, 3) = (6, 3); feed the nv-length (8, 3) instead
    with pytest.raises(ValueError, match=r"rim\['v0'\] must have shape \(6, 3\)"):
        _fit({"v0": np.zeros((nv, 3))})


# --- determinism: two runs bitwise identical ----------------------------------------------------


def test_fit_scattered_is_bitwise_deterministic():
    uv = _mx64(_scatter_uv(16))
    pts = _mx64(_cap_xyz(_np(uv)))
    a = fit_scattered(pts, uv, P, Q, 10, 10, fairness=1e-3)
    b = fit_scattered(pts, uv, P, Q, 10, 10, fairness=1e-3)
    assert np.array_equal(_np(a.poles), _np(b.poles))
    assert np.array_equal(_np(a.u_knots), _np(b.u_knots))
    assert np.array_equal(_np(a.v_knots), _np(b.v_knots))


def test_fit_scattered_with_rim_is_bitwise_deterministic():
    uv = _mx64(_scatter_uv(16))
    pts = _mx64(_cap_xyz(_np(uv)))
    rim = {"v0": _rim_curve(10)}
    a = fit_scattered(pts, uv, P, Q, 10, 10, fairness=1e-3, rim=rim)
    b = fit_scattered(pts, uv, P, Q, 10, 10, fairness=1e-3, rim=rim)
    assert np.array_equal(_np(a.poles), _np(b.poles))
