"""A plain ReLU MLP (MLX nn.Module) — the backbone of the radiance/SDF fields."""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn


class WeightNormLinear(nn.Module):
    """Linear layer with weight-normalization (T27 / ComparativeDeepDive §4.2 #2).

    Reparameterizes `weight` as `g * v / ||v||` (per-output-row), matching the spirit of
    PyTorch `nn.utils.weight_norm`. `g` and `v` are trainable leaves; at construction
    `v` is a copy of the base Linear's weight and `g` is its row L2 norm so the
    forward pass starts equivalent to the unnormalized weight.
    """

    def __init__(self, base: nn.Linear):
        super().__init__()
        w = base.weight  # (out, in)
        # Row norms — g shape (out, 1) so broadcasting works in forward.
        g = mx.linalg.norm(w, axis=1, keepdims=True)
        g = mx.maximum(g, mx.array(1e-8, dtype=w.dtype))
        self.v = w
        self.g = g
        self.bias = base.bias

    def __call__(self, x: mx.array) -> mx.array:
        v_norm = mx.linalg.norm(self.v, axis=1, keepdims=True)
        v_norm = mx.maximum(v_norm, mx.array(1e-8, dtype=self.v.dtype))
        w = self.g * (self.v / v_norm)
        # nn.Linear does x @ W.T + b
        y = x @ mx.swapaxes(w, -1, -2)
        if self.bias is not None:
            y = y + self.bias
        return y


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
