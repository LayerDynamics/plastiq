"""Typed configuration for the NeRF service — plain dataclasses, MLX-agnostic. Nested configs use
`default_factory` so each `NerfConfig()` gets independent sub-configs (no shared mutable defaults)."""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field as _field  # aliased: a dataclass attribute below is named `field`


@dataclass
class FieldConfig:
    """Radiance/SDF field MLP shape + encoding."""

    n_frequencies: int = 6  # frequency encoding bands
    hidden: int = 128
    layers: int = 4
    use_hashgrid: bool = False  # N7: swap frequency → multiresolution hash grid
    aabb: tuple[float, float] = (-1.5, 1.5)  # scene bounds the hash grid normalizes into


@dataclass
class SamplerConfig:
    """Ray-marching sample budget + scene bounds."""

    n_samples: int = 64
    near: float = 0.1
    far: float = 6.0
    importance_samples: int = 0  # N2: PDF/hierarchical samples (0 = coarse only)


@dataclass
class TrainConfig:
    """Optimizer + loop."""

    iters: int = 500
    lr: float = 5e-3
    rays_per_batch: int = 1024
    seed: int = 0


@dataclass
class NerfConfig:
    """The full config a model + trainer consume."""

    field: FieldConfig = _field(default_factory=FieldConfig)
    sampler: SamplerConfig = _field(default_factory=SamplerConfig)
    train: TrainConfig = _field(default_factory=TrainConfig)
    # Solid background colour composited behind the ray (RGB in [0,1]); None = no background (empty rays
    # stay black). Synthetic scenes render the object over a constant white background — matching it here
    # stops the model explaining the whole image as empty (→ SDF collapse). None preserves real-capture.
    background: tuple[float, float, float] | None = None
    # Silhouette-loss weight: when targets carry a 4th (alpha/mask) channel, add mask_weight·(ray
    # accumulation − alpha)² to pin opacity to the object mask (a plain colour loss can otherwise delete
    # the surface to explain the object as background). Ignored for RGB-only targets (real captures).
    mask_weight: float = 0.5
