"""Activations for field heads (MLX)."""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn


def density_activation(x: mx.array) -> mx.array:
    """Raw MLP output → non-negative density. Softplus: smooth, ≥0, numerically stable (vs trunc-exp)."""
    return nn.softplus(x)
