"""Field output heads (MLX): density (≥0) and RGB ([0,1])."""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn

from .activations import density_activation


class DensityHead(nn.Module):
    """Feature → non-negative volume density (softplus)."""

    def __init__(self, in_dim: int):
        super().__init__()
        self.linear = nn.Linear(in_dim, 1)

    def __call__(self, x: mx.array) -> mx.array:
        return density_activation(self.linear(x))


class RGBHead(nn.Module):
    """Feature → RGB colour in [0,1] (sigmoid)."""

    def __init__(self, in_dim: int):
        super().__init__()
        self.linear = nn.Linear(in_dim, 3)

    def __call__(self, x: mx.array) -> mx.array:
        return mx.sigmoid(self.linear(x))
