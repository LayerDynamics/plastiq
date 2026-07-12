"""VanillaNeRF (N6, MLX): the full model tying field + sampler + renderer into render-a-ray-batch.

For a batch of rays: sample points along each ray (UniformSampler), query the NeRFField at
(position, direction) for density+colour, and composite with the volumetric renderer → a pixel colour.
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn

from ..fields.vanilla_nerf_field import NeRFField
from ..generators.ray_samplers import PDFSampler, UniformSampler
from ..model_components.losses import mse_loss
from ..model_components.renderers import volumetric_render
from ..utils.config import NerfConfig
from ..utils.seeding import make_key


class VanillaNeRF(nn.Module):
    def __init__(self, config: NerfConfig, seed: int = 0):
        super().__init__()
        self.field = NeRFField(config.field, seed=seed)
        self.sampler = UniformSampler(
            config.sampler.n_samples, config.sampler.near, config.sampler.far, jitter=True
        )
        # Hierarchical (importance) sampling: a coarse uniform pass seeds a fine PDF pass concentrated
        # on the surface. 0 ⇒ coarse-only (the default; the two-pass path is skipped entirely).
        self.importance_samples = config.sampler.importance_samples
        self.pdf_sampler = PDFSampler(self.importance_samples) if self.importance_samples > 0 else None
        self.background = (
            mx.array(config.background, dtype=mx.float32) if config.background is not None else None
        )
        self.mask_weight = float(config.mask_weight)

    def _query(self, positions: mx.array, directions: mx.array):
        """Sampled points `(R,S,3)` + view dirs `(R,3)` → density `(R,S)`, rgb `(R,S,3)`."""
        r, s = positions.shape[0], positions.shape[1]
        dirs = mx.broadcast_to(directions[:, None, :], (r, s, 3)).reshape(-1, 3)
        density, rgb = self.field(positions.reshape(-1, 3), dirs)
        return density.reshape(r, s), rgb.reshape(r, s, 3)

    def _render(self, origins: mx.array, directions: mx.array, key: mx.array | None):
        """Render a ray batch → (rgb `(R,3)`, accumulation `(R,)`). With `importance_samples > 0`, a
        coarse uniform pass seeds a fine PDF pass; both sample sets are merged and rendered together."""
        if self.pdf_sampler is not None and key is not None:
            key, key_pdf = mx.random.split(key, 2)  # decorrelate the coarse jitter and the PDF draw
        else:
            key_pdf = key
        positions, t = self.sampler(origins, directions, key=key)  # (R,S,3), (R,S)
        if self.pdf_sampler is not None:
            density_c, rgb_c = self._query(positions, directions)
            weights = volumetric_render(density_c, rgb_c, t)["weights"]  # coarse compositing weights
            t_fine = self.pdf_sampler(t, mx.stop_gradient(weights), key=key_pdf if key_pdf is not None else make_key(0))
            t = mx.sort(mx.concatenate([t, t_fine], axis=-1), axis=-1)
            positions = origins[:, None, :] + t[:, :, None] * directions[:, None, :]
        density, rgb = self._query(positions, directions)
        out = volumetric_render(density, rgb, t)
        rendered = out["rgb"]
        if self.background is not None:
            rendered = rendered + (1.0 - out["accumulation"])[:, None] * self.background
        return rendered, out["accumulation"]

    def render_rays(self, origins: mx.array, directions: mx.array, key: mx.array | None = None) -> mx.array:
        """Rays `(R,3)` → rendered RGB `(R,3)`."""
        return self._render(origins, directions, key)[0]

    def render_loss(self, origins: mx.array, directions: mx.array, target: mx.array, key: mx.array) -> mx.array:
        """Photometric MSE, plus a silhouette term when `target` carries a 4th (alpha) channel."""
        rendered, accumulation = self._render(origins, directions, key)
        loss = mse_loss(rendered, target[:, :3])
        if target.shape[-1] == 4:
            loss = loss + self.mask_weight * mx.mean((accumulation - target[:, 3]) ** 2)
        return loss
