"""Knot-vector operations — SPEC-12 §5.2 `core/knots.py` row.

The NURBS Book (Piegl & Tiller) algorithms plus the §6.2-invariant-5 boundary
conversion:

  * ``clamped_uniform``      — clamped knot vector, uniform interior knots on [0, 1]
  * ``averaging_knots``      — Eqs. 9.68/9.69 interior-knot placement for least squares
                               (every span contains >= 1 parameter — Schoenberg–Whitney,
                               so the banded normal equations are positive definite)
  * ``compact_to_flat`` /
    ``flat_to_compact``      — compact(OCCT/NURBGen wire form: unique knots + parallel
                               multiplicities) <-> flat(textbook/geomdl) conversion.
                               THE documented interop footgun (§6.2 invariant 5): the
                               wire carries compact, the core computes on flat. This
                               array-level conversion agrees exactly with the
                               schema-level reference expansion
                               ``schema.NurbsSurface.flat_u_knots()/flat_v_knots()``.
  * ``insert_knot_curve``    — A5.1 Boehm knot insertion for a curve
  * ``insert_knot_surface``  — A5.3: A5.1 applied across every row/column of the grid
  * ``refine_knots_curve``   — A5.4 knot refinement (insert a whole vector at once)
  * ``refine_knots_surface`` — A5.5: A5.4 applied across every row/column of the grid

Data convention (the ONE convention, chosen and documented per U2.1):

  * **Knot vectors and multiplicities are plain Python lists** (``list[float]`` /
    ``list[int]``) — inputs accept any sequence, outputs are always lists. Rationale:
    they live at the schema/wire boundary where ``schema.py`` also works on lists, so
    "agrees with the schema expansion" is literal list equality.
  * **Pole and weight grids are numpy float64 ndarrays** — inputs are coerced with
    ``np.asarray(..., dtype=np.float64)`` (numpy, nested lists, and ``mx.array`` all
    accepted), outputs are always float64 ndarrays. Rationale: Boehm insertion and
    A5.4 refinement are short *sequential* host-side loops (bounded by the degree and
    the number of inserted knots, never by the batch) — exactly the shape of work the
    MLX evaluators do NOT want; MLX scatter is additionally banned as non-deterministic
    (SPEC-12 §5.3). This module is therefore deliberately host-side numpy/lists.
  * Everything converts cleanly to the MLX evaluators: pass results through
    ``mx.array(np.asarray(x, dtype=np.float64), dtype=mx.float64)`` (the explicit dtype
    matters — MLX silently downcasts float64 numpy input to float32, §5.3). This is the
    same ``_stream_for``-based f64-CPU policy `core/basis.py`/`core/eval.py` implement;
    the CPU stream engages downstream when these float64 arrays reach them.

Knot identity inside the insertion/refinement algorithms is **exact float equality**
(existing multiplicities are counted with ``==``). Tolerance-based grouping belongs to
the wire boundary only (``flat_to_compact``'s ``tol``). Rational surfaces are handled
via the homogeneous lift ``[P * w, w]`` — insert in homogeneous space, split after —
which is how OCCT (and geomdl) do it; the perspective weights stay strictly positive
because every new pole is a convex combination (alphas in [0, 1]) of positive-weight
poles. Deterministic — no RNG.
"""

import math
from bisect import bisect_left, bisect_right

import numpy as np

__all__ = [
    "averaging_knots",
    "clamped_uniform",
    "compact_to_flat",
    "flat_to_compact",
    "insert_knot_curve",
    "insert_knot_surface",
    "refine_knots_curve",
    "refine_knots_surface",
]


# --- construction ------------------------------------------------------------------------------


def clamped_uniform(n_ctrl: int, degree: int) -> list[float]:
    """Flat clamped knot vector on [0, 1] with uniformly spaced interior knots.

    ``degree + 1`` zeros, ``n_ctrl - degree - 1`` uniform interior knots
    ``i / (n_ctrl - degree)``, ``degree + 1`` ones — length ``n_ctrl + degree + 1``
    (the knot-count law). ``n_ctrl == degree + 1`` yields the Bezier vector.

    Args:
        n_ctrl: number of control points (>= degree + 1).
        degree: spline degree (>= 1).

    Returns:
        flat/textbook knot vector as a list of floats.
    """
    if degree < 1:
        raise ValueError(f"degree must be >= 1 (got {degree})")
    if n_ctrl < degree + 1:
        raise ValueError(f"n_ctrl must be >= degree + 1 = {degree + 1} (got {n_ctrl})")
    spans = n_ctrl - degree
    interior = [i / spans for i in range(1, spans)]
    return [0.0] * (degree + 1) + interior + [1.0] * (degree + 1)


def averaging_knots(params, n_ctrl: int, degree: int) -> list[float]:
    """Interior-knot placement by parameter averaging — Eqs. 9.68/9.69, clamped ends.

    The NURBS Book's least-squares knot placement: with ``m + 1`` parameters and
    ``n + 1 = n_ctrl`` control points, ``d = (m + 1) / (n - p + 1)`` and for
    ``j = 1 .. n - p``::

        i = floor(j * d);  alpha = j * d - i
        u[p + j] = (1 - alpha) * params[i - 1] + alpha * params[i]      (Eq. 9.69)

    This guarantees every knot span contains at least one parameter value
    (Schoenberg–Whitney), so the least-squares normal equations are positive definite
    and banded. Ends are clamped at 0 and 1 (the fitting domain); ``params`` should
    span the domain the way chord-length/centripetal parameterizations do (first value
    at/near 0, last at/near 1).

    Args:
        params: sorted 1-D sequence of parameters in [0, 1], ``len(params) >= n_ctrl``.
        n_ctrl: number of control points (>= degree + 1).
        degree: spline degree (>= 1).

    Returns:
        flat clamped knot vector on [0, 1], length ``n_ctrl + degree + 1``.
    """
    if degree < 1:
        raise ValueError(f"degree must be >= 1 (got {degree})")
    if n_ctrl < degree + 1:
        raise ValueError(f"n_ctrl must be >= degree + 1 = {degree + 1} (got {n_ctrl})")
    ubar = [float(x) for x in np.asarray(params, dtype=np.float64).reshape(-1)]
    if len(ubar) < n_ctrl:
        raise ValueError(
            f"need at least n_ctrl = {n_ctrl} parameters for averaging placement "
            f"(got {len(ubar)})"
        )
    if any(b < a for a, b in zip(ubar, ubar[1:])):
        raise ValueError("params must be sorted ascending")
    if ubar[0] < 0.0 or ubar[-1] > 1.0:
        raise ValueError("params must lie within [0, 1]")

    n = n_ctrl - 1
    p = degree
    m = len(ubar) - 1
    d = (m + 1) / (n - p + 1)  # Eq. 9.68
    interior: list[float] = []
    for j in range(1, n - p + 1):
        i = int(math.floor(j * d))
        alpha = j * d - i
        interior.append((1.0 - alpha) * ubar[i - 1] + alpha * ubar[i])  # Eq. 9.69

    knots = [0.0] * (p + 1) + interior + [1.0] * (p + 1)
    if any(b <= a for a, b in zip(knots[p : n + 1], knots[p + 1 : n + 2])):
        raise ValueError(
            "averaging placement produced non-increasing knots: the parameters are too "
            "clustered for this control-point count — reduce n_ctrl"
        )
    return knots


# --- compact(OCCT) <-> flat(textbook) conversion (§6.2 invariant 5) ------------------------------


def compact_to_flat(knots, mults) -> list[float]:
    """Expand compact (unique knots + multiplicities) to the flat/textbook vector.

    The array-level twin of ``schema.NurbsSurface.flat_u_knots()``: each knot value is
    repeated exactly ``mults[i]`` times, in order. Exact — values are copied verbatim.

    Args:
        knots: unique knot values, strictly increasing.
        mults: per-knot multiplicities (parallel to ``knots``), each >= 1.

    Returns:
        flat knot vector as a list of floats, length ``sum(mults)``.
    """
    knot_list = [float(k) for k in knots]
    mult_list = [int(m) for m in mults]
    if len(knot_list) != len(mult_list):
        raise ValueError(
            f"knots length ({len(knot_list)}) != mults length ({len(mult_list)})"
        )
    if any(m < 1 for m in mult_list):
        raise ValueError("multiplicities must all be >= 1")
    if any(b <= a for a, b in zip(knot_list, knot_list[1:])):
        raise ValueError("compact knots must be strictly increasing")
    flat: list[float] = []
    for knot, mult in zip(knot_list, mult_list):
        flat.extend([knot] * mult)
    return flat


def flat_to_compact(flat, tol: float = 1e-9) -> tuple[list[float], list[int]]:
    """Group a flat/textbook knot vector into compact (unique values + multiplicities).

    Values within ``tol`` of the running group's first value are the same knot (the
    group keeps its first value, so ``compact_to_flat(*flat_to_compact(flat)) == flat``
    exactly whenever repeated knots are bitwise-equal — the normal case). A value more
    than ``tol`` above the group starts the next knot; a value *below* the previous one
    (beyond ``tol``) is rejected.

    Args:
        flat: flat knot vector, non-decreasing.
        tol: grouping tolerance (wire-boundary use; core algorithms use exact equality).

    Returns:
        ``(knots, mults)`` — unique values (strictly increasing) and their
        multiplicities, ``sum(mults) == len(flat)``.
    """
    values = [float(k) for k in flat]
    if not values:
        raise ValueError("flat knot vector must be non-empty")
    if any(b < a - tol for a, b in zip(values, values[1:])):
        raise ValueError("flat knots must be non-decreasing")
    knots: list[float] = [values[0]]
    mults: list[int] = [1]
    for value in values[1:]:
        if value - knots[-1] <= tol:
            mults[-1] += 1
        else:
            knots.append(value)
            mults.append(1)
    return knots, mults


# --- shared A5.x helpers --------------------------------------------------------------------------


def _as_pole_grid(poles) -> np.ndarray:
    """Coerce poles to a float64 ndarray (accepts numpy, nested lists, mx.array)."""
    return np.array(np.asarray(poles), dtype=np.float64)


def _validate_curve(poles: np.ndarray, degree: int, flat_knots) -> tuple[list[float], int]:
    """Common A5.1/A5.4 validation; returns (knot list, last control index n)."""
    if degree < 1:
        raise ValueError(f"degree must be >= 1 (got {degree})")
    if poles.ndim != 2:
        raise ValueError(f"poles must be a 2-D (n_ctrl, dim) array (got ndim={poles.ndim})")
    knots = [float(k) for k in flat_knots]
    n = len(knots) - degree - 2
    if poles.shape[0] != n + 1:
        raise ValueError(
            f"knot-count law violated: len(knots) = {len(knots)} != "
            f"n_ctrl + degree + 1 = {poles.shape[0] + degree + 1}"
        )
    if any(b < a for a, b in zip(knots, knots[1:])):
        raise ValueError("flat knots must be non-decreasing")
    return knots, n


def _find_span(n: int, p: int, u: float, knots: list[float]) -> int:
    """A2.1 span index on a Python list: largest k in [p, n] with knots[k] <= u."""
    if u >= knots[n + 1]:
        return n
    return min(max(bisect_right(knots, u) - 1, p), n)


def _check_multiplicity(knots: list[float], p: int, u: float, adding: int) -> int:
    """Existing multiplicity of ``u`` (exact equality); reject exceeding the degree."""
    s = bisect_right(knots, u) - bisect_left(knots, u)
    if s + adding > p:
        raise ValueError(
            f"knot multiplicity would exceed the degree: u = {u} has multiplicity {s} "
            f"and inserting {adding} more gives {s + adding} > degree = {p}"
        )
    return s


def _insert_curve(
    poles: np.ndarray, p: int, knots: list[float], n: int, u: float, r: int
) -> tuple[np.ndarray, list[float]]:
    """A5.1 ``CurveKnotIns`` on a (n_ctrl, dim) float64 grid. Inputs pre-validated."""
    k = _find_span(n, p, u, knots)
    s = bisect_right(knots, u) - bisect_left(knots, u)

    new_knots = knots[: k + 1] + [u] * r + knots[k + 1 :]
    q = np.empty((n + r + 1, poles.shape[1]), dtype=np.float64)
    q[: k - p + 1] = poles[: k - p + 1]
    q[k - s + r :] = poles[k - s :]
    rw = poles[k - p : k - s + 1].copy()  # the p - s + 1 affected poles

    length = k - p  # becomes L of the final pass
    for j in range(1, r + 1):
        length = k - p + j
        for i in range(0, p - j - s + 1):
            alpha = (u - knots[length + i]) / (knots[i + k + 1] - knots[length + i])
            rw[i] = alpha * rw[i + 1] + (1.0 - alpha) * rw[i]
        q[length] = rw[0]
        q[k + r - j - s] = rw[p - j - s]
    for i in range(length + 1, k - s):
        q[i] = rw[i - length]
    return q, new_knots


def _refine_curve(
    poles: np.ndarray, p: int, knots: list[float], n: int, x: list[float]
) -> tuple[np.ndarray, list[float]]:
    """A5.4 ``RefineKnotVectCurve`` on a (n_ctrl, dim) float64 grid. Pre-validated."""
    m = n + p + 1
    r = len(x) - 1
    a = _find_span(n, p, x[0], knots)
    b = _find_span(n, p, x[r], knots) + 1

    q = np.empty((n + r + 2, poles.shape[1]), dtype=np.float64)
    new_knots = [0.0] * (m + r + 2)
    q[: a - p + 1] = poles[: a - p + 1]
    q[b + r : n + r + 2] = poles[b - 1 : n + 1]
    for j in range(0, a + 1):
        new_knots[j] = knots[j]
    for j in range(b + p, m + 1):
        new_knots[j + r + 1] = knots[j]

    i = b + p - 1
    k = b + p + r
    for j in range(r, -1, -1):
        while x[j] <= knots[i] and i > a:
            q[k - p - 1] = poles[i - p - 1]
            new_knots[k] = knots[i]
            k -= 1
            i -= 1
        q[k - p - 1] = q[k - p]
        for l in range(1, p + 1):
            ind = k - p + l
            alfa = new_knots[k + l] - x[j]
            if abs(alfa) == 0.0:
                q[ind - 1] = q[ind]
            else:
                alfa = alfa / (new_knots[k + l] - knots[i - p + l])
                q[ind - 1] = alfa * q[ind - 1] + (1.0 - alfa) * q[ind]
        new_knots[k] = x[j]
        k -= 1
    return q, new_knots


def _validate_new_knots(knots: list[float], p: int, n: int, x: list[float]) -> None:
    """A5.4/A5.5 input checks: ascending, interior, multiplicity budget per value."""
    if any(b < a for a, b in zip(x, x[1:])):
        raise ValueError("new knots must be sorted ascending")
    lo, hi = knots[p], knots[n + 1]
    for value in x:
        if not lo < value < hi:
            raise ValueError(
                f"new knot {value} lies outside the open domain ({lo}, {hi})"
            )
    for value in sorted(set(x)):
        _check_multiplicity(knots, p, value, x.count(value))


def _lift_surface(poles, weights) -> tuple[np.ndarray, bool]:
    """Rational handling: homogeneous lift ``[P * w, w]`` (how OCCT does it)."""
    grid = _as_pole_grid(poles)
    if grid.ndim != 3:
        raise ValueError(f"surface poles must be (nu, nv, dim) (got ndim={grid.ndim})")
    if weights is None:
        return grid, False
    w = np.array(np.asarray(weights), dtype=np.float64)
    if w.shape != grid.shape[:2]:
        raise ValueError(
            f"weights grid {w.shape} must match the poles grid {grid.shape[:2]}"
        )
    return np.concatenate([grid * w[..., None], w[..., None]], axis=-1), True


def _split_surface(ctrl: np.ndarray, rational: bool) -> tuple[np.ndarray, np.ndarray | None]:
    """Undo the homogeneous lift after the knot op: ``P = Pw[..., :3] / w``."""
    if not rational:
        return ctrl, None
    w = ctrl[..., -1]
    return ctrl[..., :-1] / w[..., None], w


def _apply_along_direction(op, ctrl: np.ndarray, direction: str):
    """Run a curve-level knot op across every row/column of a (nu, nv, d) grid.

    A5.3/A5.5 are exactly the curve algorithm applied to each column (direction "u")
    or row (direction "v") of the control grid, with alphas shared because they depend
    only on the knot vector — so the whole grid rides along as the curve's "dim" axis:
    reshape (nu, nv, d) -> (nu, nv*d) for u, transpose+reshape for v.
    """
    nu, nv, d = ctrl.shape
    if direction == "u":
        new2, new_knots = op(ctrl.reshape(nu, nv * d))
        return new2.reshape(-1, nv, d), new_knots
    if direction == "v":
        new2, new_knots = op(ctrl.transpose(1, 0, 2).reshape(nv, nu * d))
        return new2.reshape(-1, nu, d).transpose(1, 0, 2), new_knots
    raise ValueError(f"direction must be 'u' or 'v' (got {direction!r})")


# --- A5.1: curve knot insertion --------------------------------------------------------------------


def insert_knot_curve(
    poles, degree: int, flat_knots, u: float, times: int = 1
) -> tuple[np.ndarray, list[float]]:
    """A5.1 Boehm knot insertion for a curve: insert ``u`` ``times`` times.

    Curve points are unchanged (knot insertion is exact); only the representation
    gains ``times`` control points. ``poles`` may have any trailing dimension — pass
    homogeneous ``[P * w, w]`` poles for a rational curve.

    Args:
        poles: control points, shape ``(n_ctrl, dim)``.
        degree: spline degree.
        flat_knots: flat/textbook knot vector, length ``n_ctrl + degree + 1``.
        u: knot to insert — strictly inside the domain ``(knots[p], knots[n+1])``.
        times: insertion count; existing multiplicity + times must be <= degree.

    Returns:
        ``(new_poles, new_flat_knots)`` — shapes ``(n_ctrl + times, dim)`` and
        length ``+ times``.
    """
    grid = _as_pole_grid(poles)
    knots, n = _validate_curve(grid, degree, flat_knots)
    if times < 1:
        raise ValueError(f"times must be >= 1 (got {times})")
    u = float(u)
    lo, hi = knots[degree], knots[n + 1]
    if not lo < u < hi:
        raise ValueError(f"knot u = {u} must lie strictly inside the domain ({lo}, {hi})")
    _check_multiplicity(knots, degree, u, times)
    return _insert_curve(grid, degree, knots, n, u, times)


# --- A5.3: surface knot insertion ------------------------------------------------------------------


def insert_knot_surface(
    poles,
    weights,
    p: int,
    q: int,
    u_flat_knots,
    v_flat_knots,
    direction: str,
    u: float,
    times: int = 1,
) -> tuple[np.ndarray, np.ndarray | None, list[float], list[float]]:
    """A5.3 surface knot insertion: A5.1 across every row/column of the control grid.

    Rational surfaces go through the homogeneous lift ``[P * w, w]`` before inserting
    and are split back after (the OCCT approach) — the evaluated surface is unchanged
    and the returned weights stay strictly positive (convex combinations).

    Args:
        poles: control grid, shape ``(nu, nv, 3)``.
        weights: per-pole weights ``(nu, nv)``, or ``None`` for non-rational.
        p: degree in u.
        q: degree in v.
        u_flat_knots: flat u knot vector, length ``nu + p + 1``.
        v_flat_knots: flat v knot vector, length ``nv + q + 1``.
        direction: ``"u"`` or ``"v"`` — which knot vector receives the knot.
        u: knot value to insert (in the chosen direction's open domain).
        times: insertion count; existing multiplicity + times <= that direction's degree.

    Returns:
        ``(new_poles, new_weights_or_None, new_u_flat_knots, new_v_flat_knots)`` —
        the untouched direction's knot vector is returned as an (equal) list copy.
    """
    ctrl, rational = _lift_surface(poles, weights)
    if direction == "u":
        op = lambda grid2d: insert_knot_curve(grid2d, p, u_flat_knots, u, times)  # noqa: E731
    elif direction == "v":
        op = lambda grid2d: insert_knot_curve(grid2d, q, v_flat_knots, u, times)  # noqa: E731
    else:
        raise ValueError(f"direction must be 'u' or 'v' (got {direction!r})")
    new_ctrl, new_knots = _apply_along_direction(op, ctrl, direction)
    new_poles, new_weights = _split_surface(new_ctrl, rational)
    if direction == "u":
        return new_poles, new_weights, new_knots, [float(k) for k in v_flat_knots]
    return new_poles, new_weights, [float(k) for k in u_flat_knots], new_knots


# --- A5.4: curve knot refinement -------------------------------------------------------------------


def refine_knots_curve(
    poles, degree: int, flat_knots, new_knots
) -> tuple[np.ndarray, list[float]]:
    """A5.4 ``RefineKnotVectCurve``: insert a whole ascending vector of knots at once.

    Equivalent to (but cheaper than) sequential A5.1 insertions; curve points are
    unchanged. Repeated values in ``new_knots`` are allowed up to the per-value
    multiplicity budget (existing + inserted <= degree). An empty ``new_knots`` is the
    identity (copies returned).

    Args:
        poles: control points, shape ``(n_ctrl, dim)`` (homogeneous for rational).
        degree: spline degree.
        flat_knots: flat/textbook knot vector, length ``n_ctrl + degree + 1``.
        new_knots: knots to insert, sorted ascending, each strictly inside the domain.

    Returns:
        ``(new_poles, new_flat_knots)`` — ``len(new_knots)`` more of each.
    """
    grid = _as_pole_grid(poles)
    knots, n = _validate_curve(grid, degree, flat_knots)
    x = [float(v) for v in new_knots]
    if not x:
        return grid.copy(), list(knots)
    _validate_new_knots(knots, degree, n, x)
    return _refine_curve(grid, degree, knots, n, x)


# --- A5.5: surface knot refinement -----------------------------------------------------------------


def refine_knots_surface(
    poles,
    weights,
    p: int,
    q: int,
    u_flat_knots,
    v_flat_knots,
    direction: str,
    new_knots,
) -> tuple[np.ndarray, np.ndarray | None, list[float], list[float]]:
    """A5.5 surface knot refinement: A5.4 across every row/column of the control grid.

    Rational surfaces again go through the homogeneous lift ``[P * w, w]`` and are
    split back after — see :func:`insert_knot_surface`. The evaluated surface is
    unchanged; this is the U3.x/U5.x capacity-ladder warm-start primitive (§5.4-5).

    Args:
        poles: control grid, shape ``(nu, nv, 3)``.
        weights: per-pole weights ``(nu, nv)``, or ``None`` for non-rational.
        p: degree in u.
        q: degree in v.
        u_flat_knots: flat u knot vector, length ``nu + p + 1``.
        v_flat_knots: flat v knot vector, length ``nv + q + 1``.
        direction: ``"u"`` or ``"v"`` — which knot vector is refined.
        new_knots: knots to insert, sorted ascending, each strictly inside the domain.

    Returns:
        ``(new_poles, new_weights_or_None, new_u_flat_knots, new_v_flat_knots)`` —
        the untouched direction's knot vector is returned as an (equal) list copy.
    """
    ctrl, rational = _lift_surface(poles, weights)
    if direction == "u":
        op = lambda grid2d: refine_knots_curve(grid2d, p, u_flat_knots, new_knots)  # noqa: E731
    elif direction == "v":
        op = lambda grid2d: refine_knots_curve(grid2d, q, v_flat_knots, new_knots)  # noqa: E731
    else:
        raise ValueError(f"direction must be 'u' or 'v' (got {direction!r})")
    new_ctrl, new_flat = _apply_along_direction(op, ctrl, direction)
    new_poles, new_weights = _split_surface(new_ctrl, rational)
    if direction == "u":
        return new_poles, new_weights, new_flat, [float(k) for k in v_flat_knots]
    return new_poles, new_weights, [float(k) for k in u_flat_knots], new_flat
