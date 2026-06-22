"""Volumetric renderer (N3, MLX): composite per-sample density + colour along each ray into a pixel.

Standard NeRF alpha-compositing: `alpha = 1 − exp(−σ·δ)`, transmittance `T = ∏(1−alpha)` (exclusive),
`weights = T·alpha`; the pixel is `Σ weights·colour`, with accumulation and depth as by-products.
"""

from __future__ import annotations

import mlx.core as mx

_LAST_DELTA = 1e10  # the final sample integrates to infinity (background)


def volumetric_render(densities: mx.array, colors: mx.array, t: mx.array) -> dict[str, mx.array]:
    """densities `(R,S)` (or `(R,S,1)`), colors `(R,S,3)`, t `(R,S)` → {rgb `(R,3)`, accumulation `(R,)`,
    depth `(R,)`, weights `(R,S)`}."""
    sigma = densities[..., 0] if densities.ndim == 3 else densities
    r = sigma.shape[0]
    deltas = mx.concatenate([t[:, 1:] - t[:, :-1], mx.full((r, 1), _LAST_DELTA)], axis=-1)  # (R,S)
    alpha = 1.0 - mx.exp(-sigma * deltas)  # (R,S)
    transmittance = mx.cumprod(1.0 - alpha + 1e-10, axis=-1)  # inclusive
    t_excl = mx.concatenate([mx.ones((r, 1)), transmittance[:, :-1]], axis=-1)  # exclusive prefix
    weights = t_excl * alpha  # (R,S)
    return {
        "rgb": mx.sum(weights[..., None] * colors, axis=1),
        "accumulation": mx.sum(weights, axis=-1),
        "depth": mx.sum(weights * t, axis=-1),
        "weights": weights,
    }
