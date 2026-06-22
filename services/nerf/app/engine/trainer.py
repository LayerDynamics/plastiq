"""Trainer (N6, MLX): ray-batch photometric optimization of a NeRF/surface model.

MLX `Adam` + `nn.value_and_grad`; each step samples a random batch of rays and minimizes the MSE
between the rendered and ground-truth pixels. Deterministic: a fixed per-iteration key for the
sampler's stratified jitter and a seeded numpy RNG for the batch indices.
"""

from __future__ import annotations

from typing import Protocol

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np

from ..model_components.losses import mse_loss
from ..utils.seeding import split_keys


class RenderModel(Protocol):
    """Any model the Trainer can fit: an `nn.Module` that renders a ray batch to RGB."""

    def render_rays(self, origins: mx.array, directions: mx.array, key: mx.array | None = ...) -> mx.array: ...


class Trainer:
    def __init__(self, model: nn.Module, lr: float = 5e-3, seed: int = 0):
        self.model = model
        self.opt = optim.Adam(learning_rate=lr)
        self.seed = seed

    def train(
        self,
        origins: mx.array,
        directions: mx.array,
        target_rgb: mx.array,
        iters: int = 300,
        rays_per_batch: int = 512,
    ) -> nn.Module:
        """Fit the model to a flat set of rays `(M,3)` + target colours `(M,3)`. Returns the model."""
        m = origins.shape[0]
        keys = split_keys(self.seed, iters)
        rng = np.random.default_rng(self.seed)

        def loss_fn(model: RenderModel, o: mx.array, d: mx.array, gt: mx.array, key: mx.array) -> mx.array:
            return mse_loss(model.render_rays(o, d, key=key), gt)

        loss_and_grad = nn.value_and_grad(self.model, loss_fn)
        for i in range(iters):
            idx = mx.array(rng.integers(0, m, size=rays_per_batch).astype(np.int32))
            o, d, gt = mx.take(origins, idx, axis=0), mx.take(directions, idx, axis=0), mx.take(target_rgb, idx, axis=0)
            _, grads = loss_and_grad(self.model, o, d, gt, keys[i])
            self.opt.update(self.model, grads)
            mx.eval(self.model.parameters(), self.opt.state)
        return self.model
