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
from ..generators.ray_samplers import UniformSampler
from ..model_components.losses import eikonal_loss, mse_loss
from ..model_components.renderers import volumetric_render
from ..utils.config import NerfConfig


class BaseSurfaceModel(nn.Module):
    def __init__(self, config: NerfConfig, *, lam_eikonal: float = 0.1, seed: int = 0):
        super().__init__()
        self.field = SDFField(config.field, seed=seed)
        self.sampler = UniformSampler(
            config.sampler.n_samples, config.sampler.near, config.sampler.far, jitter=True
        )
        self.lam_eikonal = lam_eikonal

    def sdf_to_density(self, sdf: mx.array) -> mx.array:
        """Map a signed distance `(...)` to a non-negative volume density. Subclass responsibility
        (VolSDF Laplace, NeuS logistic, …)."""
        raise NotImplementedError

    def _render(self, origins: mx.array, directions: mx.array, key: mx.array | None):
        """Render a ray batch; returns (rendered RGB `(R,3)`, flat sample positions `(R·S,3)`). The
        flat positions are handed back so `render_loss` can take the eikonal gradient on them."""
        positions, t = self.sampler(origins, directions, key=key)  # (R,S,3), (R,S)
        r, s = positions.shape[0], positions.shape[1]
        flat = positions.reshape(-1, 3)
        dirs = mx.broadcast_to(directions[:, None, :], (r, s, 3)).reshape(-1, 3)
        sdf, rgb = self.field(flat, dirs)  # (R·S,1), (R·S,3)
        density = self.sdf_to_density(sdf).reshape(r, s)
        rendered = volumetric_render(density, rgb.reshape(r, s, 3), t)["rgb"]
        return rendered, flat

    def render_rays(self, origins: mx.array, directions: mx.array, key: mx.array | None = None) -> mx.array:
        """Rays `(R,3)` → rendered RGB `(R,3)`."""
        return self._render(origins, directions, key)[0]

    def render_loss(self, origins: mx.array, directions: mx.array, target: mx.array, key: mx.array) -> mx.array:
        """Photometric MSE + eikonal — the Trainer's per-batch objective for a surface model."""
        rendered, flat = self._render(origins, directions, key)
        l_photo = mse_loss(rendered, target)
        grad = mx.grad(lambda p: self.field.sdf(p).sum())(flat)  # ∂sdf/∂x per sampled point (R·S,3)
        return l_photo + self.lam_eikonal * eikonal_loss(grad)
