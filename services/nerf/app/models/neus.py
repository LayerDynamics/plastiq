"""NeuS/VolSDF surface models (N8, MLX) — the SDF-from-images family.

Shipped here is **VolSDF** (Yariv et al. 2021): the signed distance is mapped to volume density by the
CDF of a zero-mean Laplace distribution,

    σ(x) = α · Ψ_β(−sdf(x)),   α = 1/β,
    Ψ_β(s) = ½·exp(s/β)            for s ≤ 0   (outside the surface)
           = 1 − ½·exp(−s/β)       for s > 0   (inside the surface),

so density peaks at the zero level-set (σ = α/2 there) and decays smoothly with distance. β controls
surface sharpness (smaller β → tighter band). Feeding σ into the standard `volumetric_render`
alpha-compositing lets the surface train from images alone, while the base model's eikonal term keeps
the field a metric SDF whose zero level-set marching-cubes into a clean mesh. This satisfies SPEC-11
FR-2's "NeuS/VolSDF (SDF surface)" model. (NeuS's logistic opaque-density variant is the sibling in
this family; VolSDF's closed-form Laplace transform drops directly into the existing renderer.)
"""

from __future__ import annotations

import math

import mlx.core as mx

from ..utils.config import NerfConfig
from .base_surface_model import BaseSurfaceModel


class VolSDFModel(BaseSurfaceModel):
    def __init__(self, config: NerfConfig, *, laplace_beta: float = 0.2, lam_eikonal: float = 0.1,
                 learnable_beta: bool = False, beta_min: float = 5e-3, seed: int = 0):
        # β=0.2 is the stable/trainable default; smaller β gives a sharper surface but needs more
        # iterations (VolSDF anneals β large→small). With `learnable_beta` the density sharpness is a
        # trainable parameter that the optimizer anneals large→small on its own (the reference VolSDF/
        # sdfstudio behaviour) — the fixed β can never sharpen, so the surface stays soft or collapses.
        # Parameterized in log-space (β = β_min + exp(logβ)) so it stays strictly positive.
        super().__init__(config, lam_eikonal=lam_eikonal, seed=seed)
        self.learnable_beta = learnable_beta
        self.beta_min = beta_min
        if learnable_beta:
            self.log_beta = mx.array(math.log(max(laplace_beta - beta_min, 1e-4)))  # trainable leaf
        else:
            self.laplace_beta = laplace_beta

    def _beta(self):
        return (self.beta_min + mx.exp(self.log_beta)) if self.learnable_beta else self.laplace_beta

    def sdf_to_density(self, sdf: mx.array) -> mx.array:
        """VolSDF Laplace-CDF transform: signed distance `(...,1)` → density `(...,1)`.

        Both `mx.where` branches are evaluated, so the exp arguments are clamped to ≤ 0 to stop the
        UNSELECTED branch overflowing to inf for large |sdf| (which would poison gradients with 0·inf
        → NaN). On the selected branch the clamp is a no-op (the arg is already ≤ 0), so values are
        exact: ½·exp(s/β) outside, 1 − ½·exp(−s/β) inside, ×α with α = 1/β."""
        beta = self._beta()
        s = -sdf
        psi = mx.where(
            s <= 0,
            0.5 * mx.exp(mx.minimum(s / beta, 0.0)),
            1.0 - 0.5 * mx.exp(mx.minimum(-s / beta, 0.0)),
        )
        return psi / beta  # α·Ψ with α = 1/β
