"""A plain ReLU MLP (MLX nn.Module) — the backbone of the radiance/SDF fields."""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn


class MLP(nn.Module):
    def __init__(self, in_dim: int, hidden: int, out_dim: int, layers: int = 4):
        super().__init__()
        dims = [in_dim] + [hidden] * (layers - 1) + [out_dim]
        self.layers = [nn.Linear(dims[i], dims[i + 1]) for i in range(len(dims) - 1)]

    def __call__(self, x: mx.array) -> mx.array:
        for i, lin in enumerate(self.layers):
            x = lin(x)
            if i < len(self.layers) - 1:
                x = nn.relu(x)
        return x
