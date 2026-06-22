"""Losses (N3, MLX): photometric MSE and the eikonal regularizer (for SDF fields)."""

from __future__ import annotations

import mlx.core as mx


def mse_loss(pred: mx.array, target: mx.array) -> mx.array:
    """Mean-squared error between a rendered pixel batch and the ground-truth colours."""
    return mx.mean((pred - target) ** 2)


def eikonal_loss(gradients: mx.array) -> mx.array:
    """Encourage `‖∇f‖ = 1` (a metric SDF). `gradients` `(...,3)` → scalar `mean((‖g‖−1)²)`."""
    norm = mx.sqrt(mx.sum(gradients**2, axis=-1) + 1e-12)
    return mx.mean((norm - 1.0) ** 2)
