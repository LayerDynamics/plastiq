"""B-spline basis functions in pure `mlx.core` — SPEC-12 §5.2 `core/basis.py` row.

The NURBS Book (Piegl & Tiller) algorithms, batched over arbitrarily-shaped parameter
arrays with NO Python loop over the batch dimension (the only loops are over the degree
`p` and the derivative order — small constants):

  * A2.1 ``find_span``       — vectorized comparison-sum + clip (MLX has no ``searchsorted``)
  * A2.2 ``basis_funs``      — the p+1 nonzero basis values per parameter
  * A2.3 ``ders_basis_funs`` — basis-function derivatives, orders 0..k

Two-precision policy (SPEC-12 §5.3 / D-9): float64 is CPU-only in MLX, so every function
routes its ops through the CPU stream when the inputs are float64, and runs on the default
(GPU) stream for float32. Knot vectors are flat/textbook form. Deterministic — no RNG.
"""

from contextlib import nullcontext

import mlx.core as mx

__all__ = ["find_span", "basis_funs", "ders_basis_funs"]


def _stream_for(dtype: mx.Dtype):
    """CPU stream for float64 (MLX float64 is CPU-only, §5.3); default stream otherwise."""
    return mx.stream(mx.cpu) if dtype == mx.float64 else nullcontext()


def find_span(n: int, p: int, u: mx.array, knots: mx.array) -> mx.array:
    """A2.1 ``FindSpan``, batched: the knot-span index for each parameter in ``u``.

    Vectorized comparison-sum with clipping (no ``searchsorted`` in MLX):
    ``span = clip(sum(u >= knots[p : n+1]) + p - 1, p, n)``. Spans lie in ``[p, n]`` and
    satisfy ``knots[span] <= u < knots[span+1]``, except the curve end ``u == knots[n+1]``
    which returns ``n``, the last valid span (the A2.1 special case).

    Args:
        n: last control-point index (``len(knots) - p - 2``).
        p: degree.
        u: parameters, any shape, float32 or float64.
        knots: flat clamped knot vector, 1-D, same dtype family as ``u``.

    Returns:
        int32 span indices, same shape as ``u``.
    """
    with _stream_for(u.dtype):
        kv = knots.astype(u.dtype)
        # (..., n+1-p) comparison table; each True moves the span one slot right
        cmp = u[..., None] >= kv[p : n + 1]
        spans = mx.sum(cmp.astype(mx.int32), axis=-1) + (p - 1)
        return mx.clip(spans, p, n)


def basis_funs(spans: mx.array, u: mx.array, p: int, knots: mx.array) -> mx.array:
    """A2.2 ``BasisFuns``, batched: the p+1 nonzero basis values for each parameter.

    Uses the left/right knot-difference arrays of the textbook algorithm, vectorized over
    the batch (loops run over the degree only).

    Args:
        spans: A2.1 span indices for ``u`` (same shape as ``u``).
        u: parameters, any shape, float32 or float64.
        p: degree.
        knots: flat clamped knot vector, 1-D.

    Returns:
        basis values ``N[span-p .. span]``, shape ``(*u.shape, p + 1)``, dtype of ``u``.
    """
    with _stream_for(u.dtype):
        kv = knots.astype(u.dtype)
        left = [None] * (p + 1)
        right = [None] * (p + 1)
        values = [mx.ones(u.shape, dtype=u.dtype)] + [None] * p
        for j in range(1, p + 1):
            left[j] = u - mx.take(kv, spans + (1 - j))
            right[j] = mx.take(kv, spans + j) - u
            saved = mx.zeros(u.shape, dtype=u.dtype)
            for r in range(j):
                temp = values[r] / (right[r + 1] + left[j - r])
                values[r] = saved + right[r + 1] * temp
                saved = left[j - r] * temp
            values[j] = saved
        return mx.stack(values, axis=-1)


def ders_basis_funs(spans: mx.array, u: mx.array, p: int, knots: mx.array, k: int) -> mx.array:
    """A2.3 ``DersBasisFuns``, batched: basis-function derivatives of orders ``0..k``.

    Order 0 equals :func:`basis_funs`; orders above the degree are identically zero.
    Every branch in the algorithm tests loop indices (Python ints), never array values,
    so the batch stays fully vectorized.

    Args:
        spans: A2.1 span indices for ``u`` (same shape as ``u``).
        u: parameters, any shape, float32 or float64.
        p: degree.
        knots: flat clamped knot vector, 1-D.
        k: highest derivative order (k <= 2 required by SPEC-12; any k >= 0 works).

    Returns:
        derivatives ``ders[order][j]``, shape ``(*u.shape, k + 1, p + 1)``, dtype of ``u``.
    """
    with _stream_for(u.dtype):
        kv = knots.astype(u.dtype)
        zero = mx.zeros(u.shape, dtype=u.dtype)
        one = mx.ones(u.shape, dtype=u.dtype)

        # ndu upper triangle: basis values of increasing degree; lower: knot differences
        ndu = [[None] * (p + 1) for _ in range(p + 1)]
        ndu[0][0] = one
        left = [None] * (p + 1)
        right = [None] * (p + 1)
        for j in range(1, p + 1):
            left[j] = u - mx.take(kv, spans + (1 - j))
            right[j] = mx.take(kv, spans + j) - u
            saved = zero
            for r in range(j):
                ndu[j][r] = right[r + 1] + left[j - r]
                temp = ndu[r][j - 1] / ndu[j][r]
                ndu[r][j] = saved + right[r + 1] * temp
                saved = left[j - r] * temp
            ndu[j][j] = saved

        ders = [[zero] * (p + 1) for _ in range(k + 1)]
        for j in range(p + 1):
            ders[0][j] = ndu[j][p]

        # derivative rows from the a-coefficient recurrence (two alternating rows)
        a = [[zero] * (p + 1) for _ in range(2)]
        for r in range(p + 1):
            s1, s2 = 0, 1
            a[0][0] = one
            for order in range(1, min(k, p) + 1):
                d = zero
                rk = r - order
                pk = p - order
                if r >= order:
                    a[s2][0] = a[s1][0] / ndu[pk + 1][rk]
                    d = a[s2][0] * ndu[rk][pk]
                j1 = 1 if rk >= -1 else -rk
                j2 = order - 1 if r - 1 <= pk else p - r
                for j in range(j1, j2 + 1):
                    a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j]
                    d = d + a[s2][j] * ndu[rk + j][pk]
                if r <= pk:
                    a[s2][order] = -a[s1][order - 1] / ndu[pk + 1][r]
                    d = d + a[s2][order] * ndu[r][pk]
                ders[order][r] = d
                s1, s2 = s2, s1

        # multiply through by the correct factors: p! / (p - order)!
        factor = float(p)
        for order in range(1, min(k, p) + 1):
            ders[order] = [value * factor for value in ders[order]]
            factor *= float(p - order)

        return mx.stack([mx.stack(row, axis=-1) for row in ders], axis=-2)
