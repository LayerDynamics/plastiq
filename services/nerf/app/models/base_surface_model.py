"""Base surface model (N8, MLX): the shared SDF-from-images rendering loop.

A surface model renders a ray batch by sampling points along each ray, querying the `SDFField` for a
signed distance + colour, mapping the SDF to a volume density via a subclass-supplied transform
(`sdf_to_density`), and alpha-compositing with the same `volumetric_render` the radiance NeRF uses.
The training objective adds an eikonal regularizer (`‖∇sdf‖ → 1`) on the sampled points so the field
stays a metric SDF and its zero level-set marching-cubes into a clean surface.

`render_loss(origins, directions, target, key)` matches the Trainer's `RenderModel` protocol, so a
surface model trains through the exact same loop as `VanillaNeRF`. The eikonal gradient is an
input-gradient (`mx.grad` wrt the sampled positions) computed inside the loss — the outer
`value_and_grad` then differentiates that wrt the parameters (second order), the same pattern proven
in capture `sdf_mlx.py`.
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn

from ..fields.sdf_field import SDFField
from ..generators.ray_samplers import PDFSampler, UniformSampler
from ..model_components.losses import eikonal_loss, mse_loss
from ..model_components.renderers import volumetric_render
from ..utils.config import NerfConfig
from ..utils.seeding import make_key


class BaseSurfaceModel(nn.Module):
    def __init__(self, config: NerfConfig, *, lam_eikonal: float = 0.1, seed: int = 0):
        super().__init__()
        self.field = SDFField(config.field, seed=seed)
        self.sampler = UniformSampler(
            config.sampler.n_samples, config.sampler.near, config.sampler.far, jitter=True
        )
        self.lam_eikonal = lam_eikonal
        # Hierarchical (importance) sampling — see VanillaNeRF. 0 ⇒ coarse-only (default).
        self.importance_samples = config.sampler.importance_samples
        self.pdf_sampler = PDFSampler(self.importance_samples) if self.importance_samples > 0 else None
        # Constant background composited behind each ray (synthetic scenes); None ⇒ black (real capture).
        self.background = (
            mx.array(config.background, dtype=mx.float32) if config.background is not None else None
        )
        self.mask_weight = float(config.mask_weight)  # silhouette-loss weight (used iff targets carry alpha)

    def sdf_to_density(self, sdf: mx.array) -> mx.array:
        """Map a signed distance `(...)` to a non-negative volume density. Subclass responsibility
        (VolSDF Laplace, NeuS logistic, …)."""
        raise NotImplementedError

    def _density_rgb(self, positions: mx.array, directions: mx.array):
        """Sampled points `(R,S,3)` + view dirs → density `(R,S)`, rgb `(R,S,3)`, flat positions `(R·S,3)`."""
        r, s = positions.shape[0], positions.shape[1]
        flat = positions.reshape(-1, 3)
        dirs = mx.broadcast_to(directions[:, None, :], (r, s, 3)).reshape(-1, 3)
        sdf, rgb = self.field(flat, dirs)  # (R·S,1), (R·S,3)
        return self.sdf_to_density(sdf).reshape(r, s), rgb.reshape(r, s, 3), flat

    def _render(self, origins: mx.array, directions: mx.array, key: mx.array | None):
        """Render a ray batch; returns (rendered RGB `(R,3)`, flat sample positions `(R·S,3)`). The
        flat positions (the FINAL sample set) are handed back so `render_loss` takes the eikonal
        gradient on them. With `importance_samples > 0`, a coarse pass seeds a fine PDF pass."""
        if self.pdf_sampler is not None and key is not None:
            key, key_pdf = mx.random.split(key, 2)
        else:
            key_pdf = key
        positions, t = self.sampler(origins, directions, key=key)  # (R,S,3), (R,S)
        if self.pdf_sampler is not None:
            density_c, rgb_c, _ = self._density_rgb(positions, directions)
            weights = volumetric_render(density_c, rgb_c, t)["weights"]
            t_fine = self.pdf_sampler(t, mx.stop_gradient(weights), key=key_pdf if key_pdf is not None else make_key(0))
            t = mx.sort(mx.concatenate([t, t_fine], axis=-1), axis=-1)
            positions = origins[:, None, :] + t[:, :, None] * directions[:, None, :]
        density, rgb, flat = self._density_rgb(positions, directions)
        out = volumetric_render(density, rgb, t)
        rendered = out["rgb"]
        if self.background is not None:
            # pixel = Σw·c + (1−Σw)·bg — forces the SDF to model true opacity, not explain the object
            # as empty space over a bright background.
            rendered = rendered + (1.0 - out["accumulation"])[:, None] * self.background
        return rendered, flat, out["accumulation"]

    def render_rays(self, origins: mx.array, directions: mx.array, key: mx.array | None = None) -> mx.array:
        """Rays `(R,3)` → rendered RGB `(R,3)`."""
        return self._render(origins, directions, key)[0]

    def render_loss(self, origins: mx.array, directions: mx.array, target: mx.array, key: mx.array) -> mx.array:
        """Photometric MSE + eikonal, plus an optional silhouette term. When `target` carries a 4th
        (alpha) channel, add `mask_weight·(accumulation − alpha)²` so opacity is pinned to the object
        mask — without it a plain colour loss can delete the surface (the collapse on masked scenes)."""
        rendered, flat, accumulation = self._render(origins, directions, key)
        l_photo = mse_loss(rendered, target[:, :3])
        grad = mx.grad(lambda p: self.field.sdf(p).sum())(flat)  # ∂sdf/∂x per sampled point (R·S,3)
        loss = l_photo + self.lam_eikonal * eikonal_loss(grad)
        if target.shape[-1] == 4:
            loss = loss + self.mask_weight * mx.mean((accumulation - target[:, 3]) ** 2)
        return loss
