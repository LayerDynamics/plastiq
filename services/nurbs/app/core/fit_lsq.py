"""Least-squares B-spline surface fitting — SPEC-12 §5.2 `core/fit_lsq.py` row.

This module holds the deterministic least-squares initialisation of the fitting pipeline
(SPEC-12 §5.4-2/-3). It is built in two stackable layers:

  * **U3.1 — the gridded path (this file).** :func:`fit_grid` fits a structured
    ``(Nu, Nv, 3)`` sample grid with the *separable* algorithm A9.7 of The NURBS Book:
    parameterize each row/column and average (A9.3), place interior knots by averaging
    (Eqs. 9.68/9.69, via :func:`app.core.knots.averaging_knots`), then fit the u-direction
    and then the v-direction with the endpoint-interpolating A9.6 curve least squares.
    The four data corners are interpolated *exactly* (they are pinned); every other
    control point is the reduced normal-equations solution. Non-rational (weights ``None``).
  * **U3.2 — the scattered path (also this file).** :func:`fit_scattered` sits *alongside*
    :func:`fit_grid` and is structurally different: it solves the FULL normal equations
    ``(BᵀB + λLᵀL) P = BᵀQ`` over *all* control points at once (the 2-D
    :func:`app.core.eval.design_matrix` as ``B``, the control-net umbrella Laplacian
    :func:`_control_net_laplacian` as ``L``, boundary rows optionally pinned by elimination
    to given rim-curve control points), not the reduced per-direction separable solve here.
    It reuses :func:`_chol_solve` (the f64 CPU-stream Cholesky solver) directly. Knots are
    ``clamped_uniform`` (data-independent) — the fairness term keeps the system SPD without
    data-adaptive placement, and data-independent knots are what make U7.2's adjacent
    patches share an edge *by construction* (identical spline space along the seam); see
    :func:`fit_scattered` for the full rationale.

Numerics (SPEC-12 §5.3 / D-9): least-squares solves are float64 on the CPU stream. MLX has
no ``lstsq`` — the normal equations are formed explicitly and solved with
``mlx.core.linalg.cholesky`` + ``solve_triangular`` (LAPACK, CPU-stream-only). The design
matrix is built by gather + one-hot placement (never scatter — non-deterministic with
duplicate indices, §5.3). Knot vectors are flat/textbook form, as everywhere in ``core/``.
Deterministic — no RNG, fixed traversal order — so identical inputs give bitwise-identical
poles and knots.
"""

from typing import NamedTuple

import mlx.core as mx
import numpy as np

from .basis import _stream_for, basis_funs, find_span
from .eval import design_matrix
from .knots import averaging_knots, clamped_uniform

__all__ = ["GridFit", "ScatteredFit", "fit_grid", "fit_scattered", "grid_params"]


class GridFit(NamedTuple):
    """A fitted non-rational B-spline surface — drops straight into :func:`eval.surface_point`.

    All array fields are float64 ``mlx.core`` arrays (weights are implicitly ``None`` — the
    fit is non-rational for U3.1), so ``surface_point(fit.poles, None, fit.u_knots,
    fit.v_knots, fit.p, fit.q, u, v)`` evaluates the fit with zero conversion.
    """

    poles: mx.array
    """Control net, shape ``(nu, nv, 3)``, float64."""
    u_knots: mx.array
    """Flat clamped u knot vector, length ``nu + p + 1``, float64."""
    v_knots: mx.array
    """Flat clamped v knot vector, length ``nv + q + 1``, float64."""
    p: int
    """Degree in u."""
    q: int
    """Degree in v."""


def _as_f64(x) -> mx.array:
    """Coerce array-like to a float64 mx.array (MLX silently downcasts f64 numpy, §5.3)."""
    if isinstance(x, mx.array) and x.dtype == mx.float64:
        return x
    return mx.array(np.asarray(x, dtype=np.float64), dtype=mx.float64)


def _flat_knots_mx(flat) -> mx.array:
    """A flat/textbook knot list from :mod:`.knots` as a float64 mx.array."""
    return mx.array(np.asarray(flat, dtype=np.float64), dtype=mx.float64)


def _normalized_cumulative(chords: mx.array, axis: int) -> mx.array:
    """Per-line normalized cumulative parameters with an exact 0 start and 1.0 end.

    ``chords`` are the consecutive segment lengths along ``axis`` (already square-rooted
    once for centripetal). Each line is divided by its *last* cumulative element (not a
    separate sum) so the final parameter is exactly ``total / total == 1.0`` — the same
    device :func:`app.core.params._cumulative_params` uses — and a leading zero slice is
    prepended so the first parameter is exactly 0.

    A zero (or non-finite) per-line total means a coincident grid line, which would make
    ``cum / last`` a NaN that slips silently past :func:`app.core.knots.averaging_knots`
    (its ``<``/``<=``/``>`` guards are all False against NaN) to the output. That is
    rejected with a clear ``ValueError`` — the FR-6 "never a silent NaN" contract
    :mod:`app.core.params` enforces for degenerate point sequences.

    Raises:
        ValueError: any per-line chord total is zero or non-finite (a coincident u/v line).
    """
    cum = mx.cumsum(chords, axis=axis)
    last = mx.take(cum, mx.array([cum.shape[axis] - 1]), axis=axis)  # keepdim slice of the total
    if not bool(mx.all((last > 0.0) & mx.isfinite(last)).item()):
        raise ValueError(
            "degenerate grid: zero chord length along a u/v grid line — coincident points"
        )
    normed = cum / last
    zero_shape = list(chords.shape)
    zero_shape[axis] = 1
    zero = mx.zeros(zero_shape, dtype=chords.dtype)
    return mx.concatenate([zero, normed], axis=axis)


def grid_params(points_grid, param: str = "centripetal") -> tuple[mx.array, mx.array]:
    """A9.3 averaged parameters ``(uk, vl)`` for a structured sample grid.

    Each column (fixed v) is chord-length (Eqs. 9.4/9.5) or centripetal (Eq. 9.6)
    parameterized in the u-direction and the results averaged over v to give ``uk``; each
    row is parameterized in v and averaged over u to give ``vl`` — this is exactly geomdl's
    ``compute_params_surface`` (the per-curve formula matching :func:`app.core.params`'s).
    Endpoints are exactly 0 and 1 and the parameters are non-decreasing.

    Args:
        points_grid: ordered sample grid, shape ``(Nu, Nv, 3)``.
        param: ``"centripetal"`` (default, Eq. 9.6) or ``"chord"`` (Eqs. 9.4/9.5).

    Returns:
        ``(uk, vl)`` — float64 mx.arrays of shape ``(Nu,)`` and ``(Nv,)``, in ``[0, 1]``.
    """
    if param not in ("centripetal", "chord"):
        raise ValueError(f"param must be 'centripetal' or 'chord' (got {param!r})")
    pts = _as_f64(points_grid)
    if pts.ndim != 3 or pts.shape[-1] != 3:
        raise ValueError(f"points_grid must be (Nu, Nv, 3) (got shape {tuple(pts.shape)})")
    with _stream_for(mx.float64):
        du = pts[1:, :, :] - pts[:-1, :, :]  # (Nu-1, Nv, 3)
        chord_u = mx.sqrt(mx.sum(du * du, axis=-1))  # (Nu-1, Nv)
        dv = pts[:, 1:, :] - pts[:, :-1, :]  # (Nu, Nv-1, 3)
        chord_v = mx.sqrt(mx.sum(dv * dv, axis=-1))  # (Nu, Nv-1)
        if param == "centripetal":  # Eq. 9.6: chord lengths enter under a square root
            chord_u = mx.sqrt(chord_u)
            chord_v = mx.sqrt(chord_v)
        uk = mx.mean(_normalized_cumulative(chord_u, axis=0), axis=1)  # (Nu,)
        vl = mx.mean(_normalized_cumulative(chord_v, axis=1), axis=0)  # (Nv,)
        return uk, vl


def _design_matrix_1d(params: mx.array, flat_knots: mx.array, degree: int, n_ctrl: int) -> mx.array:
    """Dense 1-D B-spline collocation matrix ``N`` of shape ``(N, n_ctrl)``.

    ``N[r, k] = N_k(params[r])`` — each row's ``degree + 1`` nonzero basis values placed at
    columns ``span-degree .. span`` by gather + one-hot matmul (never scatter, §5.3), the
    same construction :func:`app.core.eval.design_matrix` uses per direction. Built here in
    1-D on purpose: A9.7 fits each direction independently, and the 2-D tensor-product
    ``eval.design_matrix`` cannot express a single-direction curve fit.

    Args:
        params: 1-D parameters in the knot domain, float64.
        flat_knots: flat clamped knot vector, length ``n_ctrl + degree + 1``, float64.
        degree: spline degree.
        n_ctrl: number of control points.

    Returns:
        collocation matrix, shape ``(params.shape[0], n_ctrl)``, dtype of ``params``.
    """
    dtype = params.dtype
    with _stream_for(dtype):
        kv = flat_knots.astype(dtype)
        spans = find_span(n_ctrl - 1, degree, params, kv)  # (N,)
        values = basis_funs(spans, params, degree, kv)  # (N, degree+1)
        cols = spans[:, None] + (mx.arange(degree + 1) - degree)  # (N, degree+1)
        one_hot = (cols[..., None] == mx.arange(n_ctrl)).astype(dtype)  # (N, degree+1, n_ctrl)
        return mx.sum(values[..., None] * one_hot, axis=-2)  # (N, n_ctrl)


def _chol_solve(gram: mx.array, rhs: mx.array) -> mx.array:
    """Solve the SPD normal-equation system ``gram @ x = rhs`` by Cholesky (f64, CPU stream).

    MLX has no ``lstsq`` and its LAPACK-backed linalg runs on the CPU stream only (§5.3), so
    the symmetric-positive-definite normal matrix is factored with
    ``mlx.core.linalg.cholesky`` and back-solved through the two triangular systems. This is
    the reusable f64 solver the U3.2 scattered path shares.

    Args:
        gram: SPD matrix, shape ``(n, n)``, float64.
        rhs: right-hand side, shape ``(n, k)``, float64.

    Returns:
        solution ``x``, shape ``(n, k)``, float64.
    """
    with mx.stream(mx.cpu):
        lower = mx.linalg.cholesky(gram, upper=False)
        y = mx.linalg.solve_triangular(lower, rhs, upper=False)
        return mx.linalg.solve_triangular(lower.T, y, upper=True)


def _fit_curve_batch(
    data: mx.array, params: mx.array, flat_knots: mx.array, degree: int, n_ctrl: int
) -> mx.array:
    """A9.6 endpoint-interpolating curve LSQ, batched over the trailing axes.

    Fits ``data`` (shape ``(Ndata, *batch)``) along axis 0 with ``n_ctrl`` control points:
    the first and last control points are pinned to the first and last data samples (exact
    endpoint interpolation, clamped ends), and the interior control points solve the reduced
    normal equations of Eqs. 9.63/9.67 — ``R[r] = Q[r] - N_0(u_r) Q_0 - N_{n-1}(u_r) Q_m``
    over the interior data rows, ``(Nint^T Nint) Pint = Nint^T R`` — via :func:`_chol_solve`.

    Args:
        data: samples to fit, shape ``(Ndata, *batch)`` (the u-fit passes ``(Nu, Nv, 3)``;
            the v-fit passes ``(Nv, nu, 3)`` after a transpose).
        params: data parameters, shape ``(Ndata,)``, float64, endpoints 0 and 1.
        flat_knots: flat clamped knot vector, length ``n_ctrl + degree + 1``, float64.
        degree: spline degree.
        n_ctrl: number of control points (``degree + 1 <= n_ctrl <= Ndata``).

    Returns:
        control points, shape ``(n_ctrl, *batch)``, float64.
    """
    with _stream_for(mx.float64):
        n_data = data.shape[0]
        batch_shape = data.shape[1:]
        first, last = data[0], data[n_data - 1]  # pinned endpoints, shape (*batch)
        if n_ctrl <= 2:  # only the two pinned endpoints remain (Bezier-degenerate)
            return mx.stack([first, last], axis=0)

        collocation = _design_matrix_1d(params, flat_knots, degree, n_ctrl)  # (Ndata, n_ctrl)
        interior = collocation[1 : n_data - 1, 1 : n_ctrl - 1]  # (Ndata-2, n_ctrl-2)
        n0 = collocation[1 : n_data - 1, 0]  # (Ndata-2,) — first basis on interior params
        nlast = collocation[1 : n_data - 1, n_ctrl - 1]  # (Ndata-2,) — last basis
        # broadcast the pinned-endpoint contributions across the batch (Eq. 9.63)
        pad = (slice(None),) + (None,) * len(batch_shape)
        residual = data[1 : n_data - 1] - n0[pad] * first[None] - nlast[pad] * last[None]

        flat_batch = int(np.prod(batch_shape)) if batch_shape else 1
        rhs2d = residual.reshape(n_data - 2, flat_batch)  # (Ndata-2, prod(batch))
        gram = interior.T @ interior  # (n_ctrl-2, n_ctrl-2) SPD (Schoenberg–Whitney)
        ntr = interior.T @ rhs2d  # (n_ctrl-2, prod(batch))
        interior_poles = _chol_solve(gram, ntr).reshape(n_ctrl - 2, *batch_shape)
        return mx.concatenate([first[None], interior_poles, last[None]], axis=0)


def fit_grid(points_grid, p: int, q: int, nu: int, nv: int, *, param: str = "centripetal") -> GridFit:
    """Separable least-squares B-spline surface fit of a structured sample grid (A9.7).

    Parameterizes the grid (A9.3 averaging via :func:`grid_params`), places clamped interior
    knots by averaging (Eqs. 9.68/9.69, :func:`app.core.knots.averaging_knots` — identical to
    geomdl's ``compute_knot_vector2``), then fits the u-direction (each of the ``Nv`` columns)
    and then the v-direction (each of the ``nu`` intermediate rows) with the
    endpoint-interpolating A9.6 curve LSQ. The four data corners are interpolated exactly;
    the boundary curves and interior are least-squares approximations. Non-rational.

    Args:
        points_grid: ordered sample grid, shape ``(Nu, Nv, 3)``.
        p: target degree in u (``1 <= p``, ``nu >= p + 1``).
        q: target degree in v.
        nu: number of control points in u (``p + 1 <= nu <= Nu``).
        nv: number of control points in v (``q + 1 <= nv <= Nv``).
        param: ``"centripetal"`` (default) or ``"chord"`` — the parameterization method.

    Returns:
        :class:`GridFit` ``(poles (nu, nv, 3), u_knots, v_knots, p, q)`` — float64 arrays
        that plug straight into :func:`app.core.eval.surface_point`.
    """
    pts = _as_f64(points_grid)
    if pts.ndim != 3 or pts.shape[-1] != 3:
        raise ValueError(f"points_grid must be (Nu, Nv, 3) (got shape {tuple(pts.shape)})")
    n_u, n_v = pts.shape[0], pts.shape[1]
    if not (p + 1 <= nu <= n_u):
        raise ValueError(f"nu must satisfy p + 1 = {p + 1} <= nu <= Nu = {n_u} (got {nu})")
    if not (q + 1 <= nv <= n_v):
        raise ValueError(f"nv must satisfy q + 1 = {q + 1} <= nv <= Nv = {n_v} (got {nv})")

    uk, vl = grid_params(pts, param=param)
    u_knots = _flat_knots_mx(averaging_knots([float(x) for x in np.array(uk)], nu, p))
    v_knots = _flat_knots_mx(averaging_knots([float(x) for x in np.array(vl)], nv, q))

    with _stream_for(mx.float64):
        # u-direction: fit each column (data axis 0) -> intermediate poles (nu, Nv, 3)
        intermediate = _fit_curve_batch(pts, uk, u_knots, p, nu)
        # v-direction: fit each row -> (nu, nv, 3). Move v to axis 0, fit, move back.
        fitted = _fit_curve_batch(intermediate.transpose(1, 0, 2), vl, v_knots, q, nv)
        poles = fitted.transpose(1, 0, 2)
        mx.eval(poles, u_knots, v_knots)  # force the lazy graph once (deterministic result)
    return GridFit(poles=poles, u_knots=u_knots, v_knots=v_knots, p=p, q=q)


# ================================================================================================
# U3.2 — scattered-data least squares with control-net fairness + rim pinning (SPEC-12 §5.4-3)
# ================================================================================================


class ScatteredFit(NamedTuple):
    """A fitted non-rational B-spline surface from :func:`fit_scattered`.

    Mirrors :class:`GridFit` field-for-field so it drops straight into
    :func:`app.core.eval.surface_point` (weights implicitly ``None`` — non-rational):
    ``surface_point(fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q, u, v)``.
    """

    poles: mx.array
    """Control net, shape ``(nu, nv, 3)``, float64."""
    u_knots: mx.array
    """Flat clamped u knot vector, length ``nu + p + 1``, float64."""
    v_knots: mx.array
    """Flat clamped v knot vector, length ``nv + q + 1``, float64."""
    p: int
    """Degree in u."""
    q: int
    """Degree in v."""


# The four control-net boundary lines a ``rim`` spec may pin (see :func:`fit_scattered`).
_RIM_EDGES = ("u0", "u1", "v0", "v1")


def _control_net_laplacian(nu: int, nv: int) -> mx.array:
    """The uniform (umbrella) discrete Laplacian ``L`` over the ``nu × nv`` control net.

    The net is flattened in the same ``i * nv + j`` column order as
    :func:`app.core.eval.design_matrix`. Row ``k`` for pole ``(i, j)`` is
    ``L[k] · P = P[i, j] − mean(4-neighbours)`` — the interior stencil is a pole minus the
    average of its four grid-neighbours (up/down/left/right).

    **Boundary handling (documented):** boundary and corner poles average over only the 3
    (edge) or 2 (corner) grid-neighbours they actually have — no phantom exterior nodes are
    invented. This is the standard umbrella/uniform Laplacian (Taubin), and it is the
    property that makes the fit unconditionally solvable: on a connected grid the umbrella
    operator's null space is exactly the constant vectors (``L · 1 = 0``), and the design
    matrix's rows are a partition of unity (``B · 1 = 1 ≠ 0``), so no nonzero vector lies in
    both ``null(BᵀB)`` and ``null(LᵀL)``. Hence ``BᵀB + λ·LᵀL`` is symmetric *positive
    definite* for **any** ``λ > 0`` regardless of how the scattered data is distributed or
    how the knots fall — which is why :func:`fit_scattered` can use data-independent
    ``clamped_uniform`` knots and still Cholesky-factor a data-sparse patch.

    Built host-side in numpy (a small dense ``(nu*nv, nu*nv)`` matrix, deterministic index
    bookkeeping — the same host-side rationale as :mod:`app.core.knots`) and returned as a
    float64 ``mx.array``.

    Args:
        nu: control points in u (``>= 2``).
        nv: control points in v (``>= 2``).

    Returns:
        the Laplacian ``L``, shape ``(nu*nv, nu*nv)``, float64 ``mx.array``.
    """
    n = nu * nv
    lap = np.zeros((n, n), dtype=np.float64)
    for i in range(nu):
        for j in range(nv):
            k = i * nv + j
            neighbours = []
            if i > 0:
                neighbours.append((i - 1) * nv + j)
            if i < nu - 1:
                neighbours.append((i + 1) * nv + j)
            if j > 0:
                neighbours.append(i * nv + (j - 1))
            if j < nv - 1:
                neighbours.append(i * nv + (j + 1))
            lap[k, k] = 1.0
            weight = -1.0 / len(neighbours)  # nu, nv >= 2 ⇒ every pole has >= 2 neighbours
            for m in neighbours:
                lap[k, m] = weight
    return mx.array(lap, dtype=mx.float64)


def _register_rim_target(targets: dict[int, np.ndarray], idx: int, value: np.ndarray) -> None:
    """Record a pinned target for control-net index ``idx``; reject inconsistent overlaps.

    A control-net corner lies on two boundary lines; if a ``rim`` spec pins it from both
    edges the two values must agree (within ``1e-12``) or the spec is contradictory.

    When both edges agree within that ``1e-12`` tolerance, the last key registered for the
    shared index wins (``targets[idx] = value`` overwrites) — deterministic for a fixed
    ``rim`` dict, and the ``<= 1e-12`` discrepancy is ``<<`` the ``1e-6`` sew tolerance, so
    last-write-wins is not a watertightness risk.
    """
    if idx in targets and not np.allclose(targets[idx], value, rtol=0.0, atol=1e-12):
        raise ValueError(
            f"rim spec over-specifies control-net index {idx} with inconsistent corner "
            f"values {targets[idx].tolist()} vs {value.tolist()}"
        )
    targets[idx] = value


def _resolve_rim(rim: dict, nu: int, nv: int) -> tuple[np.ndarray, np.ndarray]:
    """Flatten a ``rim`` edge spec to ``(pinned_indices, pinned_values)`` (sorted, host-side).

    See :func:`fit_scattered` for the ``rim`` contract. Returns the pinned control-net
    linear indices (``i * nv + j``, sorted ascending for determinism) and the parallel
    ``(len, 3)`` float64 target positions.
    """
    if not isinstance(rim, dict):
        raise ValueError(f"rim must be a dict of edge specs (got {type(rim).__name__})")
    targets: dict[int, np.ndarray] = {}
    for key, values in rim.items():
        if key not in _RIM_EDGES:
            raise ValueError(f"rim key must be one of {_RIM_EDGES} (got {key!r})")
        arr = np.asarray(values, dtype=np.float64)
        if key in ("u0", "u1"):  # a control-net row poles[i0, :] — nv points
            i0 = 0 if key == "u0" else nu - 1
            if arr.shape != (nv, 3):
                raise ValueError(f"rim[{key!r}] must have shape ({nv}, 3) (got {arr.shape})")
            for j in range(nv):
                _register_rim_target(targets, i0 * nv + j, arr[j])
        else:  # "v0"/"v1": a control-net column poles[:, j0] — nu points
            j0 = 0 if key == "v0" else nv - 1
            if arr.shape != (nu, 3):
                raise ValueError(f"rim[{key!r}] must have shape ({nu}, 3) (got {arr.shape})")
            for i in range(nu):
                _register_rim_target(targets, i * nv + j0, arr[i])
    indices = np.array(sorted(targets), dtype=np.int64)
    positions = np.array([targets[k] for k in indices], dtype=np.float64)
    return indices, positions


def _solve_pinned(
    normal: mx.array, rhs: mx.array, pinned_idx: np.ndarray, pinned_val: np.ndarray, n: int
) -> mx.array:
    """Solve the SPD system with ``pinned_idx`` control points fixed, by ELIMINATION.

    Partition ``(BᵀB + λLᵀL) P = BᵀQ`` into free ``F`` and pinned ``R`` columns; with
    ``P_R`` known this reduces to ``A_FF P_F = c_F − A_FR P_R``. ``A_FF`` is a principal
    submatrix of the SPD full matrix, hence itself SPD — so :func:`_chol_solve` applies.
    Submatrices are gathered with :func:`mlx.core.take` (never scatter, §5.3); the final
    reassembly of ``P`` from ``P_F``/``P_R`` is deterministic numpy fancy-indexing (the
    same host-side index-bookkeeping rationale as :mod:`app.core.knots`).

    The pinned rows of the returned ``P`` are *exactly* ``pinned_val`` (they are copied in,
    never solved) — the U7.2 shared-boundary exactness property.
    """
    free_mask = np.ones(n, dtype=bool)
    free_mask[pinned_idx] = False
    free_idx = np.nonzero(free_mask)[0]
    if free_idx.size == 0:  # every pole pinned — nothing to solve
        full = np.empty((n, 3), dtype=np.float64)
        full[pinned_idx] = np.asarray(pinned_val, dtype=np.float64)
        return mx.array(full, dtype=mx.float64)

    fidx = mx.array(free_idx.astype(np.int32), dtype=mx.int32)
    pidx = mx.array(pinned_idx.astype(np.int32), dtype=mx.int32)
    pinned = _as_f64(pinned_val)  # (npin, 3)
    free_rows = mx.take(normal, fidx, axis=0)  # (nF, n)
    a_ff = mx.take(free_rows, fidx, axis=1)  # (nF, nF) — SPD principal submatrix
    a_fr = mx.take(free_rows, pidx, axis=1)  # (nF, npin)
    c_f = mx.take(rhs, fidx, axis=0)  # (nF, 3)
    p_free = _chol_solve(a_ff, c_f - a_fr @ pinned)  # (nF, 3)

    full = np.empty((n, 3), dtype=np.float64)
    full[free_idx] = np.asarray(p_free, dtype=np.float64)
    full[pinned_idx] = np.asarray(pinned, dtype=np.float64)
    return mx.array(full, dtype=mx.float64)


def fit_scattered(
    points,
    uv,
    p: int,
    q: int,
    nu: int,
    nv: int,
    *,
    fairness: float = 1e-3,
    rim: dict | None = None,
) -> ScatteredFit:
    """Scattered-data least-squares B-spline surface fit (SPEC-12 §5.4-3).

    The unstructured generalization of the gridded A9.7 path: given ``M`` scattered 3-D
    samples ``points`` at their surface parameters ``uv`` in ``[0, 1]²`` (the caller supplies
    ``uv`` from ``app.param``'s harmonic disk map or a projection — this function does *not*
    parameterize meshes), solve the FULL normal equations over every control point at once::

        (BᵀB + λ·LᵀL) P = BᵀQ

    * ``B`` = :func:`app.core.eval.design_matrix` ``(M, nu*nv)`` — column layout ``i*nv + j``.
    * ``L`` = :func:`_control_net_laplacian` — the umbrella control-net Laplacian; the
      fairness term ``λ·LᵀL`` penalizes wrinkling in data-sparse spans (Tikhonov / discrete
      thin-plate) and makes the matrix SPD for any ``λ > 0`` (see :func:`_control_net_laplacian`).
    * ``Q`` = ``points`` ``(M, 3)``; all three coordinates share one Cholesky factor.

    Solved with :func:`_chol_solve` (Cholesky, float64, CPU stream — D-9; MLX has no
    ``lstsq``). Non-rational. Deterministic (no RNG, fixed traversal order).

    **Knots — ``clamped_uniform`` (documented choice).** Unlike the gridded path, the
    scattered fit uses *data-independent* clamped-uniform knots, NOT ``averaging_knots``.
    Two reasons: (1) the ``λ·LᵀL`` fairness term already guarantees an SPD system without
    needing knot placement to satisfy Schoenberg–Whitney against the (arbitrary) scattered
    sample distribution; (2) U7.2 requires two adjacent patches to occupy the *identical*
    spline space along their shared edge so the seam is watertight by construction —
    data-independent knots make the shared-edge knot vectors bitwise-identical between
    patches, which ``averaging_knots`` (different uv distributions ⇒ different knots) cannot.

    **``rim`` — boundary pinning contract (U7.2 shared boundary).** ``rim`` is an optional
    dict pinning any subset of the control net's four boundary lines to given 3-D rim-curve
    control points, enforced by ELIMINATION (the pinned poles are moved to the RHS and the
    reduced interior system is solved, so the pinned rows come out *exactly* equal to the
    supplied values). The keys and the control-net indices they pin are precisely:

    * ``"u0"`` → ``poles[0, :]``      (the ``i = 0`` row)      — value shape ``(nv, 3)``
    * ``"u1"`` → ``poles[nu-1, :]``   (the ``i = nu-1`` row)   — value shape ``(nv, 3)``
    * ``"v0"`` → ``poles[:, 0]``      (the ``j = 0`` column)   — value shape ``(nu, 3)``
    * ``"v1"`` → ``poles[:, nv-1]``   (the ``j = nv-1`` column)— value shape ``(nu, 3)``

    Because the ends are clamped, evaluating the fitted surface along a pinned edge (e.g.
    ``v = 0`` for ``"v0"``) reproduces exactly the B-spline curve whose control polygon is
    the pinned values on this direction's ``clamped_uniform`` knots. Two patches pinned to
    the *same* rim curve therefore coincide along that edge to solver precision — watertight
    by construction (SPEC-7 D-3's sagitta lesson), not by sew tolerance. A control-net corner
    lies on two boundary lines; if pinned from both keys the two values must agree (within
    ``1e-12``) or a ``ValueError`` is raised.

    Args:
        points: scattered 3-D samples, shape ``(M, 3)``.
        uv: their surface parameters in ``[0, 1]²``, shape ``(M, 2)``.
        p: degree in u (``1 <= p``, ``nu >= p + 1``).
        q: degree in v (``1 <= q``, ``nv >= q + 1``).
        nu: control points in u.
        nv: control points in v.
        fairness: the ``λ`` Tikhonov/Laplacian fairness weight (``>= 0``; ``0`` disables the
            fairness term and may leave a data-sparse system ill-conditioned — the caller's
            risk, see the fairness discussion above).
        rim: optional boundary-pinning spec (see the contract above), or ``None``.

    Returns:
        :class:`ScatteredFit` ``(poles (nu, nv, 3), u_knots, v_knots, p, q)`` — float64
        arrays that plug straight into :func:`app.core.eval.surface_point`.

    Raises:
        ValueError: bad shapes, ``nu < p + 1`` / ``nv < q + 1``, negative ``fairness``,
            an empty sample set, or an inconsistent/over-specified ``rim``.
    """
    pts = _as_f64(points)
    uvf = _as_f64(uv)
    if pts.ndim != 2 or pts.shape[-1] != 3:
        raise ValueError(f"points must be (M, 3) (got shape {tuple(pts.shape)})")
    if uvf.ndim != 2 or uvf.shape[-1] != 2:
        raise ValueError(f"uv must be (M, 2) (got shape {tuple(uvf.shape)})")
    if pts.shape[0] != uvf.shape[0]:
        raise ValueError(f"points and uv must share M (got {pts.shape[0]} vs {uvf.shape[0]})")
    if pts.shape[0] < 1:
        raise ValueError("fit_scattered requires at least one sample (got an empty set)")
    if p < 1 or nu < p + 1:
        raise ValueError(f"nu must satisfy p + 1 = {p + 1} <= nu (got p={p}, nu={nu})")
    if q < 1 or nv < q + 1:
        raise ValueError(f"nv must satisfy q + 1 = {q + 1} <= nv (got q={q}, nv={nv})")
    if fairness < 0.0:
        raise ValueError(f"fairness (λ) must be >= 0 (got {fairness})")

    u_knots = _flat_knots_mx(clamped_uniform(nu, p))
    v_knots = _flat_knots_mx(clamped_uniform(nv, q))
    n = nu * nv

    with _stream_for(mx.float64):
        b = design_matrix(uvf[:, 0], uvf[:, 1], u_knots, v_knots, p, q, nu, nv)  # (M, n)
        normal = b.T @ b  # BᵀB, (n, n) — PSD; SPD once fairness is added
        if fairness > 0.0:
            lap = _control_net_laplacian(nu, nv)
            normal = normal + fairness * (lap.T @ lap)
        rhs = b.T @ pts  # BᵀQ, (n, 3)

        if rim is None:
            poles_flat = _chol_solve(normal, rhs)  # (n, 3)
        else:
            pinned_idx, pinned_val = _resolve_rim(rim, nu, nv)
            poles_flat = _solve_pinned(normal, rhs, pinned_idx, pinned_val, n)

        poles = poles_flat.reshape(nu, nv, 3)
        mx.eval(poles, u_knots, v_knots)  # force the lazy graph once (deterministic result)
    return ScatteredFit(poles=poles, u_knots=u_knots, v_knots=v_knots, p=p, q=q)
