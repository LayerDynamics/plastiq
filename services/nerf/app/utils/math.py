"""Small MLX math helpers."""

from __future__ import annotations

import mlx.core as mx


def safe_normalize(v: mx.array, axis: int = -1, eps: float = 1e-12) -> mx.array:
    """Unit-normalize along `axis` without dividing by zero — a zero vector maps to zero (not NaN)."""
    norm = mx.sqrt(mx.sum(v * v, axis=axis, keepdims=True))
    return v / mx.maximum(norm, eps)
