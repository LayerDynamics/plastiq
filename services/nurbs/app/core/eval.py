"""Tensor-product NURBS surface evaluation in pure `mlx.core` — SPEC-12 §5.2 `core/eval.py` row.

The NURBS Book (Piegl & Tiller) algorithms, batched over arbitrarily-shaped parameter
arrays with NO Python loop over the batch dimension (the only loops in the call chain
are :mod:`.basis`'s loops over the degree — small constants):

  * A3.5 ``surface_point`` (non-rational) / A4.3 (rational: homogeneous coordinates +
    perspective divide) — evaluation at paired parameters ``(u[i], v[i])``
  * A3.6 / A4.4 (order 1) ``surface_derivs`` — the point and both first partials
  * ``design_matrix`` — the dense evaluation matrix ``B`` so that evaluation becomes a
    batched matmul ``B @ P`` (gather + one-hot matmul; NO scatter — MLX scatter is
    non-deterministic with duplicate indices, SPEC-12 §5.3)

Control windows are gathered per point with :func:`mlx.core.take` on flattened
``i * nv + j`` indices, then contracted against the basis-value outer products.

Two-precision policy (SPEC-12 §5.3 / D-9): float64 is CPU-only in MLX, so every function
routes its ops through the CPU stream when the parameters are float64, and runs on the
default (GPU) stream for float32. Knot vectors are flat/textbook form (compact↔flat
conversion is `core/knots.py`'s job). Deterministic — no RNG.
"""

from typing import NamedTuple

import mlx.core as mx

from .basis import _stream_for, basis_funs, ders_basis_funs, find_span

__all__ = ["SurfaceDerivs", "design_matrix", "surface_derivs", "surface_point"]


class SurfaceDerivs(NamedTuple):
    """First-order surface derivative bundle: each field has shape ``(*batch, 3)``."""

    S: mx.array
    """The surface point ``S(u, v)``."""
    Su: mx.array
    """First partial derivative ``dS/du``."""
    Sv: mx.array
    """First partial derivative ``dS/dv``."""


def _homogeneous(poles: mx.array, weights: mx.array) -> mx.array:
    """Lift ``(nu, nv, d)`` poles to homogeneous ``(nu, nv, d + 1)``: ``[P * w, w]``."""
    w = weights[..., None]
    return mx.concatenate([poles * w, w], axis=-1)


def _control_window(ctrl: mx.array, spans_u: mx.array, spans_v: mx.array, p: int, q: int) -> mx.array:
    """Gather each point's ``(p+1, q+1)`` control window from a ``(nu, nv, d)`` grid.

    Pure gather: flattened ``i * nv + j`` indices into ``ctrl.reshape(nu * nv, d)`` via
    ``mx.take`` (no scatter). Returns shape ``(*batch, p + 1, q + 1, d)``.
    """
    nv = ctrl.shape[1]
    iu = spans_u[..., None] + (mx.arange(p + 1) - p)  # (*batch, p+1): span-p .. span
    iv = spans_v[..., None] + (mx.arange(q + 1) - q)  # (*batch, q+1)
    flat = iu[..., :, None] * nv + iv[..., None, :]  # (*batch, p+1, q+1)
    return mx.take(ctrl.reshape(-1, ctrl.shape[-1]), flat, axis=0)


def _contract(window: mx.array, bu: mx.array, bv: mx.array) -> mx.array:
    """Sum ``bu_i * bv_j * window[..., i, j, :]`` over the ``(p+1, q+1)`` window."""
    return mx.sum(window * bu[..., :, None, None] * bv[..., None, :, None], axis=(-3, -2))


def surface_point(
    poles: mx.array,
    weights: mx.array | None,
    u_knots: mx.array,
    v_knots: mx.array,
    p: int,
    q: int,
    u: mx.array,
    v: mx.array,
) -> mx.array:
    """A3.5 ``SurfacePoint`` / A4.3 rational, batched: ``S(u[i], v[i])`` per parameter pair.

    Non-rational when ``weights is None``; otherwise rational via homogeneous coordinates
    (poles scaled by weights, weight appended, tensor-product evaluated, perspective
    divide — A4.3).

    Args:
        poles: control grid, shape ``(nu, nv, 3)``.
        weights: per-pole weights ``(nu, nv)``, or ``None`` for the non-rational path.
        u_knots: flat clamped knot vector for u, length ``nu + p + 1``.
        v_knots: flat clamped knot vector for v, length ``nv + q + 1``.
        p: degree in u.
        q: degree in v.
        u: u parameters, any shape, float32 or float64.
        v: v parameters, same shape as ``u``.

    Returns:
        surface points, shape ``(*u.shape, 3)``, dtype of ``u``.
    """
    dtype = u.dtype
    with _stream_for(dtype):
        ku = u_knots.astype(dtype)
        kv = v_knots.astype(dtype)
        ctrl = poles.astype(dtype)
        if weights is not None:
            ctrl = _homogeneous(ctrl, weights.astype(dtype))
        spans_u = find_span(poles.shape[0] - 1, p, u, ku)
        spans_v = find_span(poles.shape[1] - 1, q, v, kv)
        bu = basis_funs(spans_u, u, p, ku)
        bv = basis_funs(spans_v, v, q, kv)
        out = _contract(_control_window(ctrl, spans_u, spans_v, p, q), bu, bv)
        if weights is None:
            return out
        return out[..., :-1] / out[..., -1:]


def surface_derivs(
    poles: mx.array,
    weights: mx.array | None,
    u_knots: mx.array,
    v_knots: mx.array,
    p: int,
    q: int,
    u: mx.array,
    v: mx.array,
) -> SurfaceDerivs:
    """A3.6 / A4.4 (order 1), batched: the point and both first partials per pair.

    Non-rational (``weights is None``): direct tensor-product contraction of the basis
    derivative rows (A3.6). Rational: the order-1 quotient rule of A4.4 on the
    homogeneous numerator ``A`` and weight function ``w`` —
    ``S = A/w``, ``S_u = (A_u - w_u * S) / w``, ``S_v = (A_v - w_v * S) / w``.

    Args: identical to :func:`surface_point`.

    Returns:
        :class:`SurfaceDerivs` named tuple ``(S, Su, Sv)`` — each of shape
        ``(*u.shape, 3)``, dtype of ``u``.
    """
    dtype = u.dtype
    with _stream_for(dtype):
        ku = u_knots.astype(dtype)
        kv = v_knots.astype(dtype)
        ctrl = poles.astype(dtype)
        if weights is not None:
            ctrl = _homogeneous(ctrl, weights.astype(dtype))
        spans_u = find_span(poles.shape[0] - 1, p, u, ku)
        spans_v = find_span(poles.shape[1] - 1, q, v, kv)
        du = ders_basis_funs(spans_u, u, p, ku, 1)  # (*batch, 2, p+1)
        dv = ders_basis_funs(spans_v, v, q, kv, 1)  # (*batch, 2, q+1)
        window = _control_window(ctrl, spans_u, spans_v, p, q)
        a = _contract(window, du[..., 0, :], dv[..., 0, :])
        a_u = _contract(window, du[..., 1, :], dv[..., 0, :])
        a_v = _contract(window, du[..., 0, :], dv[..., 1, :])
        if weights is None:
            return SurfaceDerivs(S=a, Su=a_u, Sv=a_v)
        w, w_u, w_v = a[..., -1:], a_u[..., -1:], a_v[..., -1:]
        s = a[..., :-1] / w
        return SurfaceDerivs(S=s, Su=(a_u[..., :-1] - w_u * s) / w, Sv=(a_v[..., :-1] - w_v * s) / w)


def _dense_rows(values: mx.array, spans: mx.array, degree: int, n_ctrl: int) -> mx.array:
    """Place each row's ``degree + 1`` basis values at columns ``span-degree .. span``.

    One-hot matmul construction (deterministic — never scatter, SPEC-12 §5.3): compare
    the window's column indices against ``arange(n_ctrl)`` and contract. Returns
    ``(N, n_ctrl)``.
    """
    cols = spans[..., None] + (mx.arange(degree + 1) - degree)  # (N, degree+1)
    one_hot = (cols[..., None] == mx.arange(n_ctrl)).astype(values.dtype)  # (N, degree+1, n_ctrl)
    return mx.sum(values[..., None] * one_hot, axis=-2)


def design_matrix(
    u: mx.array,
    v: mx.array,
    u_knots: mx.array,
    v_knots: mx.array,
    p: int,
    q: int,
    nu: int,
    nv: int,
) -> mx.array:
    """Dense B-spline design matrix ``B`` of shape ``(N, nu * nv)`` — evaluation as matmul.

    ``N = u.size`` (arbitrary batch shapes are flattened in C order). Row ``r`` holds the
    ``(p+1)(q+1)`` products ``N_i(u_r) * N_j(v_r)`` at columns ``i * nv + j``, so that

    * ``B @ poles.reshape(nu * nv, 3)`` equals the non-rational :func:`surface_point`, and
    * ``B @ Pw.reshape(nu * nv, 4)`` (homogeneous poles ``[P * w, w]``) followed by the
      perspective divide equals the rational path.

    Every row sums to 1 (partition of unity). This matrix is the workhorse contract for
    the U3 least-squares fit (normal equations ``(BᵀB + λLᵀL) P = BᵀQ``, SPEC-12 §5.4-3)
    and the U5 gradient refinement (evaluation inside the loss is ``B @ P``): both depend
    on exactly this column layout and on ``B``-times-control-points reproducing the
    evaluators above. Built by gather + one-hot matmul — no scatter (SPEC-12 §5.3).

    Float64 note (SPEC-12 §5.3, D-9): like every op here, when ``u``/``v`` are float64 the
    ``B @ poles`` matmul must run on the CPU stream — evaluate it under ``_stream_for`` /
    ``with mx.stream(mx.cpu)`` (float64 is unsupported on the Metal GPU stream and raises).
    ``design_matrix`` itself already routes through ``_stream_for``; downstream consumers
    doing the ``B @ P`` product must do the same (``core/fit_lsq.py`` is the reference).

    Args:
        u: u parameters, any shape, float32 or float64.
        v: v parameters, same shape as ``u``.
        u_knots: flat clamped knot vector for u, length ``nu + p + 1``.
        v_knots: flat clamped knot vector for v, length ``nv + q + 1``.
        p: degree in u.
        q: degree in v.
        nu: number of control points in u.
        nv: number of control points in v.

    Returns:
        dense design matrix, shape ``(N, nu * nv)``, dtype of ``u``.
    """
    dtype = u.dtype
    with _stream_for(dtype):
        uf = u.reshape(-1)
        vf = v.reshape(-1)
        ku = u_knots.astype(dtype)
        kv = v_knots.astype(dtype)
        spans_u = find_span(nu - 1, p, uf, ku)
        spans_v = find_span(nv - 1, q, vf, kv)
        rows_u = _dense_rows(basis_funs(spans_u, uf, p, ku), spans_u, p, nu)  # (N, nu)
        rows_v = _dense_rows(basis_funs(spans_v, vf, q, kv), spans_v, q, nv)  # (N, nv)
        # per-row outer product lands N_i(u) * N_j(v) exactly at column i * nv + j
        return (rows_u[:, :, None] * rows_v[:, None, :]).reshape(uf.shape[0], nu * nv)
