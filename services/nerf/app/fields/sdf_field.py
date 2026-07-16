"""The SDF field (N8, MLX): position → signed distance (+ geometry feature), (feature, view) → RGB.

The surface counterpart to the radiance `NeRFField`. A Softplus MLP with the IGR geometric
initialization (Gropp et al. / Atzmon-Lipman, the scheme proven in capture `sdf_mlx.py`) so the
network approximates the sphere SDF `‖x‖ − radius` at init — correct sign from the start (negative
inside), which is what makes SDF-from-images training converge. The trunk emits the signed distance
plus a geometry feature; a small head turns (feature, encoded view direction) into view-dependent
RGB. `sdf()` exposes the scalar field on its own so a model can take `mx.grad` for the eikonal term.

Unlike `NeRFField`, the SDF trunk consumes RAW 3D coordinates (no positional encoding): the geometric
init formula assumes raw `x`, and a metric SDF is smooth/low-frequency by nature.
"""

from __future__ import annotations

import math

import mlx.core as mx
import mlx.nn as nn
import numpy as np

from ..field_components.encodings import FrequencyEncoding
from ..field_components.field_heads import RGBHead
from ..field_components.mlp import MLP, WeightNormLinear
from ..utils.config import FieldConfig


class SDFField(nn.Module):
    def __init__(
        self,
        config: FieldConfig,
        *,
        radius: float = 1.0,
        softplus_beta: float = 100.0,
        feature_dim: int = 64,
        seed: int = 0,
        use_weight_norm: bool = False,
    ):
        super().__init__()
        self.softplus_beta = softplus_beta
        self.feature_dim = feature_dim
        hidden, n_layers = config.hidden, config.layers
        mx.random.seed(seed)  # determinism for the colour head's Linear inits (NFR-1)

        # SDF trunk: raw 3D → (1 signed distance + feature_dim geometry feature), Softplus, geometric init.
        dims = [3] + [hidden] * n_layers + [1 + feature_dim]
        linears = [nn.Linear(dims[i], dims[i + 1]) for i in range(len(dims) - 1)]
        rng = np.random.default_rng(seed)
        last = len(linears) - 1
        for i, layer in enumerate(linears):
            out_dim, in_dim = layer.weight.shape
            if i == last:
                # near-zero last layer EXCEPT the SDF row (row 0), which gets the geometric init so
                # the output approximates ‖x‖ − radius; bias[0] = −radius (negative inside).
                w = rng.normal(0.0, 1e-5, size=(out_dim, in_dim))
                w[0] = rng.normal(math.sqrt(math.pi) / math.sqrt(in_dim), 1e-5, size=(in_dim,))
                b = np.zeros(out_dim, dtype=np.float32)
                b[0] = -radius
                layer.weight = mx.array(w.astype(np.float32))
                layer.bias = mx.array(b)
            else:
                w = rng.normal(0.0, math.sqrt(2.0 / out_dim), size=(out_dim, in_dim))
                layer.weight = mx.array(w.astype(np.float32))
                layer.bias = mx.array(np.zeros(out_dim, dtype=np.float32))
        # Optional weight-norm on hidden layers (T27). Default off — short VolSDF
        # training tests regress under WN; enable via use_weight_norm for research runs.
        if use_weight_norm:
            self.trunk_layers = [
                WeightNormLinear(lin) if i < last else lin for i, lin in enumerate(linears)
            ]
        else:
            self.trunk_layers = linears

        # Colour head: (geometry feature + encoded view direction) → RGB in [0,1].
        self.dir_enc = FrequencyEncoding(4)
        rgb_hidden = max(16, hidden // 2)
        self.rgb_trunk = MLP(feature_dim + self.dir_enc.output_dim(3), rgb_hidden, rgb_hidden, 2)
        self.rgb_head = RGBHead(rgb_hidden)

    def _trunk(self, x: mx.array) -> mx.array:
        """Raw positions `(...,3)` → `(...,1+feature_dim)` (signed distance ‖ feature)."""
        h = x
        for layer in self.trunk_layers[:-1]:
            h = nn.softplus(self.softplus_beta * layer(h)) / self.softplus_beta
        return self.trunk_layers[-1](h)

    def sdf(self, x: mx.array) -> mx.array:
        """Signed distance only `(...,1)` — the scalar field a model differentiates for eikonal."""
        return self._trunk(x)[..., :1]

    def __call__(self, positions: mx.array, directions: mx.array):
        """`(N,3)` positions + view dirs → (signed distance `(N,1)`, RGB `(N,3)`)."""
        out = self._trunk(positions)
        sdf, feat = out[..., :1], out[..., 1:]
        rgb = self.rgb_head(self.rgb_trunk(mx.concatenate([feat, self.dir_enc(directions)], axis=-1)))
        return sdf, rgb
