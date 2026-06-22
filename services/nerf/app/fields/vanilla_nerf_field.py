"""The NeRF radiance field (N4, MLX): position → density, (position, direction) → RGB.

Composed from field_components: a frequency-encoded position runs through an MLP trunk → density +
a feature; the feature concatenated with the encoded view direction → a small MLP → RGB. View
dependence is what lets a NeRF model specular/anisotropic appearance.
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn

from ..field_components.encodings import FrequencyEncoding, HashGridEncoding
from ..field_components.field_heads import DensityHead, RGBHead
from ..field_components.mlp import MLP
from ..utils.config import FieldConfig


class NeRFField(nn.Module):
    def __init__(self, config: FieldConfig, seed: int = 0):
        super().__init__()
        mx.random.seed(seed)  # deterministic init (NFR-1)
        if config.use_hashgrid:
            self.pos_enc = HashGridEncoding(aabb=config.aabb, seed=seed)
            pos_dim = self.pos_enc.output_dim  # property (N7)
        else:
            self.pos_enc = FrequencyEncoding(config.n_frequencies)
            pos_dim = self.pos_enc.output_dim(3)
        self.dir_enc = FrequencyEncoding(4)
        self.trunk = MLP(pos_dim, config.hidden, config.hidden, config.layers)
        self.density_head = DensityHead(config.hidden)
        rgb_hidden = max(16, config.hidden // 2)
        self.rgb_trunk = MLP(config.hidden + self.dir_enc.output_dim(3), rgb_hidden, rgb_hidden, 2)
        self.rgb_head = RGBHead(rgb_hidden)

    def __call__(self, positions: mx.array, directions: mx.array):
        feat = self.trunk(self.pos_enc(positions))
        density = self.density_head(feat)
        rgb = self.rgb_head(self.rgb_trunk(mx.concatenate([feat, self.dir_enc(directions)], axis=-1)))
        return density, rgb
