"""Curve/surface parameter utilities in pure `mlx.core` — SPEC-12 §5.2 `core/params.py` row.

The NURBS Book (Piegl & Tiller) algorithms, batched and deterministic (no RNG):

  * Eqs. 9.4/9.5 ``chord_length_params`` / Eq. 9.6 ``centripetal_params`` — cumulative
    parameterization of an ordered point sequence onto [0, 1].
  * §6.1 ``project_points`` — batched point projection/inversion: per 3-D point, the
    (u, v) minimizing |S(u, v) - P|, seeded on a uniform lattice and polished with a
    fixed number of damped-free Newton iterations on the §6.1 system (Eqs. 6.3–6.6).

    **Gauss–Newton simplification (documented honestly):** the book's full Jacobian of
    ``f = Su·r``, ``g = Sv·r`` (``r = S - P``) contains second-derivative terms
    ``r·Suu``, ``r·Suv``, ``r·Svv``. :mod:`.eval` provides first derivatives only
    (``surface_derivs`` is order 1), so the Jacobian here is the first-order
    Gauss–Newton approximation ``[[|Su|², Su·Sv], [Su·Sv, |Sv|²]]``. For points on or
    near the surface (r → 0) the dropped terms vanish and convergence is the full
    Newton's quadratic; for far points the iteration is linear with rate proportional
    to |r|·curvature — acceptable for the parameter-correction/deviation use cases
    (SPEC-12 §5.4-4) where points sit near the fitted surface.
  * ``deviation`` — the (rms, max) projection-distance metric that U5.1's losses and
    the FR-9 report build on.

Determinism: no RNG; fixed seed lattice, fixed iteration count (no data-dependent early
exit), gather-only indexing (no scatter — SPEC-12 §5.3), and the two-precision policy of
:mod:`.basis`/:mod:`.eval` (float64 pinned to the CPU stream via ``_stream_for``).
Knot vectors are flat/textbook form, as everywhere in ``core/``.
"""

from typing import NamedTuple

import mlx.core as mx

from .basis import _stream_for
from .eval import surface_derivs, surface_point

__all__ = ["Projection", "centripetal_params", "chord_length_params", "deviation", "project_points"]

# elements-per-chunk budget for the seed-lattice distance table (points × grid²)
_SEED_CHUNK_ELEMS = 4_194_304
# relative floor for the Gauss-Newton Gram determinant |Su|²|Sv|² − (Su·Sv)²:
# below it the tangents are (numerically) parallel and the step is zeroed
_DET_RTOL = 1e-14


class Projection(NamedTuple):
    """Result of :func:`project_points` for ``N`` input points."""

    uv: mx.array
    """Projected parameters, shape ``(N, 2)``, clamped to the surface domain."""
    distance: mx.array
    """Euclidean distance ``|S(u, v) - P|`` per point, shape ``(N,)``."""
    converged: mx.array
    """Bool per point: §6.1 point-coincidence (ε1) OR zero-cosine (ε2) criterion holds.

    This reports the book's ε1/ε2 criteria, *not* a KKT boundary condition. When an
    off-surface point's true foot point lies on the clamped ``[0, 1]²`` domain edge, the
    step is clamped to the rim and the residual stays non-orthogonal (it cannot be reduced
    across the boundary), so ``converged`` reads ``False`` even though the constrained
    minimum was in fact reached.
    """


def _cumulative_params(lengths: mx.array, dtype: mx.Dtype) -> mx.array:
    """Normalized cumulative sums with exact endpoints: [0, …, 1].

    The total is taken from the *last cumulative element* (not a separate ``sum``) so the
    final parameter is exactly ``total / total == 1.0`` bitwise.
    """
    cum = mx.cumsum(lengths)
    return mx.concatenate([mx.zeros((1,), dtype=dtype), cum / cum[-1]])


def chord_length_params(points: mx.array) -> mx.array:
    """Eqs. 9.4/9.5 chord-length parameterization of an ordered point sequence.

    ``t_0 = 0``, ``t_k = t_{k-1} + |Q_k - Q_{k-1}| / d`` with ``d`` the total chord
    length — endpoints are exactly 0 and 1.

    Args:
        points: ordered points, shape ``(N, 3)`` (N >= 2, no repeated consecutive
            points), float32 or float64.

    Returns:
        parameters in ``[0, 1]``, shape ``(N,)``, dtype of ``points``.

    Raises:
        ValueError: fewer than 2 points, or a degenerate sequence with zero total chord
            length (all points coincident) — never a silent NaN (FR-6).
    """
    n = points.shape[0]
    if n < 2:
        raise ValueError(f"chord-length parameterization needs at least 2 points, got {n}")
    dtype = points.dtype
    with _stream_for(dtype):
        chords = mx.sqrt(mx.sum((points[1:] - points[:-1]) ** 2, axis=-1))
        if mx.sum(chords).item() <= 0.0:
            raise ValueError(
                "degenerate point sequence: zero total chord length — all points coincident"
            )
        return _cumulative_params(chords, dtype)


def centripetal_params(points: mx.array) -> mx.array:
    """Eq. 9.6 centripetal parameterization: chord lengths enter under a square root.

    Damps parameter jumps across long chords — the book's recommendation for data with
    sharp turns or clustered spacing. Endpoints are exactly 0 and 1.

    Args: identical to :func:`chord_length_params`.

    Returns:
        parameters in ``[0, 1]``, shape ``(N,)``, dtype of ``points``.

    Raises:
        ValueError: fewer than 2 points, or a degenerate sequence with zero total chord
            length (all points coincident) — never a silent NaN (FR-6).
    """
    n = points.shape[0]
    if n < 2:
        raise ValueError(f"centripetal parameterization needs at least 2 points, got {n}")
    dtype = points.dtype
    with _stream_for(dtype):
        chords = mx.sqrt(mx.sum((points[1:] - points[:-1]) ** 2, axis=-1))
        if mx.sum(chords).item() <= 0.0:
            raise ValueError(
                "degenerate point sequence: zero total chord length — all points coincident"
            )
        return _cumulative_params(mx.sqrt(chords), dtype)


def _seed_uv(points: mx.array, lattice: mx.array, uu: mx.array, vv: mx.array) -> tuple[mx.array, mx.array]:
    """Nearest seed-lattice node per point: vectorized argmin, chunked over the batch.

    ``lattice`` is the ``(G, 3)`` table of surface points at the flattened ``(uu, vv)``
    lattice parameters. Chunking bounds the ``points × G`` distance table at
    ``_SEED_CHUNK_ELEMS`` elements; per-point argmins are independent, so the chunk
    boundaries cannot change the result (deterministic; first index wins ties).
    """
    n_pts = points.shape[0]
    chunk = max(1, _SEED_CHUNK_ELEMS // lattice.shape[0])
    parts = []
    for start in range(0, n_pts, chunk):
        block = points[start : start + chunk]
        d2 = mx.sum((block[:, None, :] - lattice[None, :, :]) ** 2, axis=-1)
        parts.append(mx.argmin(d2, axis=-1))
    idx = parts[0] if len(parts) == 1 else mx.concatenate(parts)
    return mx.take(uu, idx), mx.take(vv, idx)


def project_points(
    points: mx.array,
    poles: mx.array,
    weights: mx.array | None,
    u_knots: mx.array,
    v_knots: mx.array,
    p: int,
    q: int,
    *,
    seed_grid: int = 32,
    newton_iters: int = 12,
    eps_point: float = 1e-9,
    eps_cos: float = 1e-9,
) -> Projection:
    """§6.1 batched point projection/inversion: per point, (u, v) minimizing |S(u,v) - P|.

    Two phases, both batched over all ``N`` points at once:

    1. **Seed** — ``S`` is evaluated on a ``seed_grid × seed_grid`` uniform lattice over
       the domain in ONE batched :func:`~app.core.eval.surface_point` call; each point
       takes its nearest lattice node (vectorized argmin, chunked when ``N × grid²`` is
       large).
    2. **Newton** — exactly ``newton_iters`` iterations of the 2×2 system of Eqs.
       6.3–6.6 (``f = Su·r``, ``g = Sv·r``, ``r = S - P``) using the first-order
       **Gauss–Newton** Jacobian ``[[|Su|², Su·Sv], [Su·Sv, |Sv|²]]`` — the
       ``r·S_**`` second-derivative terms are dropped because :mod:`.eval` provides
       first derivatives only (see the module docstring for the honest convergence
       consequences). ``(u, v)`` is clamped to the knot domain after every step; steps
       with a (numerically) singular Gram matrix are zeroed.

    The iteration count is fixed — no data-dependent early exit — so results are
    deterministic. The book's two convergence criteria are *reported* per point instead
    of used as stopping rules: point coincidence ``|r| <= eps_point`` (ε1) OR zero
    cosine ``|Su·r| / (|Su| |r|) <= eps_cos`` and ``|Sv·r| / (|Sv| |r|) <= eps_cos``
    (ε2). These are the book's ε1/ε2 tests, *not* a KKT boundary condition: a point whose
    nearest foot is clamped to a ``[0, 1]²`` domain edge reaches its constrained minimum
    but is reported ``converged = False`` (the rim residual cannot be made orthogonal) —
    see :attr:`Projection.converged`.

    Args:
        points: query points, shape ``(N, 3)``, float32 or float64 (float64 runs on the
            CPU stream, §5.3).
        poles: control grid, shape ``(nu, nv, 3)``.
        weights: per-pole weights ``(nu, nv)``, or ``None`` for the non-rational path.
        u_knots: flat clamped knot vector for u, length ``nu + p + 1``.
        v_knots: flat clamped knot vector for v, length ``nv + q + 1``.
        p: degree in u.
        q: degree in v.
        seed_grid: lattice resolution per direction for phase 1.
        newton_iters: fixed Gauss–Newton iteration count for phase 2.
        eps_point: §6.1 ε1 — point-coincidence distance tolerance.
        eps_cos: §6.1 ε2 — zero-cosine (orthogonality) tolerance.

    Returns:
        :class:`Projection` named tuple ``(uv (N, 2), distance (N,), converged (N,) bool)``.

    Raises:
        ValueError: an empty point array (``N == 0``) — the seed/argmin path is undefined
            with no points, so this is rejected with a clear message instead of crashing
            deep in the argmin/concatenate.
    """
    n = points.shape[0]
    if n == 0:
        raise ValueError("project_points requires at least one point (got an empty (0, 3) array)")
    dtype = points.dtype
    with _stream_for(dtype):
        ku = u_knots.astype(dtype)
        kv = v_knots.astype(dtype)
        nu, nv = poles.shape[0], poles.shape[1]
        u_lo, u_hi = ku[p].item(), ku[nu].item()
        v_lo, v_hi = kv[q].item(), kv[nv].item()

        # phase 1: seed on the uniform lattice (one batched surface_point call)
        gu = mx.linspace(u_lo, u_hi, seed_grid, dtype=dtype)
        gv = mx.linspace(v_lo, v_hi, seed_grid, dtype=dtype)
        uu = mx.broadcast_to(gu[:, None], (seed_grid, seed_grid)).reshape(-1)
        vv = mx.broadcast_to(gv[None, :], (seed_grid, seed_grid)).reshape(-1)
        lattice = surface_point(poles, weights, u_knots, v_knots, p, q, uu, vv)
        u, v = _seed_uv(points, lattice, uu, vv)

        # phase 2: fixed Gauss-Newton iterations (loop over the small fixed count only)
        for _ in range(newton_iters):
            s = surface_derivs(poles, weights, u_knots, v_knots, p, q, u, v)
            r = s.S - points
            f = mx.sum(s.Su * r, axis=-1)  # Eq. 6.3
            g = mx.sum(s.Sv * r, axis=-1)  # Eq. 6.4
            a = mx.sum(s.Su * s.Su, axis=-1)
            b = mx.sum(s.Su * s.Sv, axis=-1)
            c = mx.sum(s.Sv * s.Sv, axis=-1)
            det = a * c - b * b  # Gram determinant >= 0; ~0 only for parallel tangents
            ok = det > _DET_RTOL * a * c
            safe = mx.where(ok, det, mx.ones_like(det))
            du = mx.where(ok, (b * g - c * f) / safe, mx.zeros_like(det))  # Eqs. 6.5/6.6
            dv = mx.where(ok, (b * f - a * g) / safe, mx.zeros_like(det))
            u = mx.clip(u + du, u_lo, u_hi)
            v = mx.clip(v + dv, v_lo, v_hi)

        # final metrics + the book's two convergence criteria (reported, not stopping)
        s = surface_derivs(poles, weights, u_knots, v_knots, p, q, u, v)
        r = s.S - points
        distance = mx.sqrt(mx.sum(r * r, axis=-1))
        norm_su = mx.sqrt(mx.sum(s.Su * s.Su, axis=-1))
        norm_sv = mx.sqrt(mx.sum(s.Sv * s.Sv, axis=-1))
        # guarded cosines: a zero denominator (|r| = 0 or degenerate tangent) reads as 0
        denom_u = mx.where(norm_su * distance > 0.0, norm_su * distance, mx.ones_like(distance))
        denom_v = mx.where(norm_sv * distance > 0.0, norm_sv * distance, mx.ones_like(distance))
        zero = mx.zeros_like(distance)
        cos_u = mx.where(norm_su * distance > 0.0, mx.abs(mx.sum(s.Su * r, axis=-1)) / denom_u, zero)
        cos_v = mx.where(norm_sv * distance > 0.0, mx.abs(mx.sum(s.Sv * r, axis=-1)) / denom_v, zero)
        converged = (distance <= eps_point) | ((cos_u <= eps_cos) & (cos_v <= eps_cos))
        return Projection(uv=mx.stack([u, v], axis=-1), distance=distance, converged=converged)


def deviation(
    points: mx.array,
    poles: mx.array,
    weights: mx.array | None,
    u_knots: mx.array,
    v_knots: mx.array,
    p: int,
    q: int,
) -> tuple[float, float]:
    """Project ``points`` onto the surface and return ``(rms, max)`` distances.

    **Contract:** this is the deviation metric that U5.1's loss suite (`core/losses.py`
    rms/max deviation) and the FR-9 fit report build on — both consume exactly these two
    scalars, computed from :func:`project_points` with its default seed/iteration
    budget: ``rms = sqrt(mean(d²))`` and ``max = max(d)`` over the per-point projection
    distances ``d``.

    Args: identical to :func:`project_points` (defaults for the keyword knobs).

    Returns:
        ``(rms, max)`` as Python floats.
    """
    projected = project_points(points, poles, weights, u_knots, v_knots, p, q)
    with _stream_for(points.dtype):
        d = projected.distance
        rms = mx.sqrt(mx.mean(d * d))
        return float(rms.item()), float(mx.max(d).item())
