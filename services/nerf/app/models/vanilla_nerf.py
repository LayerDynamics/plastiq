"""VanillaNeRF (N6, MLX): the full model tying field + sampler + renderer into render-a-ray-batch.

For a batch of rays: sample points along each ray (UniformSampler), query the NeRFField at
(position, direction) for density+colour, and composite with the volumetric renderer → a pixel colour.
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn

from ..fields.vanilla_nerf_field import NeRFField
from ..generators.ray_samplers import UniformSampler
from ..model_components.renderers import volumetric_render
from ..utils.config import NerfConfig


class VanillaNeRF(nn.Module):
    def __init__(self, config: NerfConfig, seed: int = 0):
        super().__init__()
        self.field = NeRFField(config.field, seed=seed)
        self.sampler = UniformSampler(
            config.sampler.n_samples, config.sampler.near, config.sampler.far, jitter=True
        )

    def render_rays(self, origins: mx.array, directions: mx.array, key: mx.array | None = None) -> mx.array:
        """Rays `(R,3)` → rendered RGB `(R,3)`."""
        positions, t = self.sampler(origins, directions, key=key)  # (R,S,3), (R,S)
        r, s = positions.shape[0], positions.shape[1]
        dirs = mx.broadcast_to(directions[:, None, :], (r, s, 3)).reshape(-1, 3)
        density, rgb = self.field(positions.reshape(-1, 3), dirs)
        return volumetric_render(density.reshape(r, s), rgb.reshape(r, s, 3), t)["rgb"]
