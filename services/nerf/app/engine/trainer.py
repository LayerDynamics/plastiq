"""Trainer (N6, MLX): ray-batch photometric optimization of a NeRF/surface model.

MLX `Adam` + `nn.value_and_grad`; each step samples a random batch of rays and minimizes the MSE
between the rendered and ground-truth pixels — unless `rays_per_batch` covers the whole set, in which
case every step trains full-batch (exact gradients, no batch-sampling noise). Deterministic: a fixed
per-iteration key for the sampler's stratified jitter and a seeded numpy RNG for the batch indices.
"""

from __future__ import annotations

from typing import Protocol

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np

from ..utils.seeding import split_keys


class RenderModel(Protocol):
    """Any model the Trainer can fit: an `nn.Module` exposing `render_loss` (the total per-batch loss —
    photometric MSE for a NeRF, MSE + eikonal for a surface model)."""

    def render_loss(self, origins: mx.array, directions: mx.array, target: mx.array, key: mx.array) -> mx.array: ...


class Trainer:
    def __init__(self, model: nn.Module, lr: float = 5e-3, seed: int = 0):
        self.model = model
        self.lr = lr
        self.opt = optim.Adam(learning_rate=lr)
        self.seed = seed

    def train(
        self,
        origins: mx.array,
        directions: mx.array,
        target_rgb: mx.array,
        iters: int = 300,
        rays_per_batch: int = 512,
        *,
        grad_clip: float | None = None,
        warmup_frac: float = 0.0,
        lr_final_frac: float = 1.0,
    ) -> nn.Module:
        """Fit the model to a flat set of rays `(M,3)` + target colours `(M,3)`. Returns the model.

        Stability controls (opt-in; defaults reproduce the constant-LR, no-clip behaviour):
        ``grad_clip`` caps the global gradient norm each step — the direct fix for the SDF-explosion
        divergence on hard (masked/synthetic) scenes. ``warmup_frac`` linearly ramps the LR from 0 over
        the first fraction of steps, then it cosine-decays to ``lr_final_frac × lr`` — the schedule the
        reference NeuS relies on to converge instead of collapsing early."""
        m = origins.shape[0]
        keys = split_keys(self.seed, iters)
        rng = np.random.default_rng(self.seed)

        if warmup_frac > 0.0 or lr_final_frac < 1.0:
            warm = int(iters * warmup_frac)
            if warm > 0:
                sched = optim.join_schedules(
                    [optim.linear_schedule(0.0, self.lr, warm),
                     optim.cosine_decay(self.lr, max(1, iters - warm), self.lr * lr_final_frac)],
                    [warm],
                )
            else:
                sched = optim.cosine_decay(self.lr, iters, self.lr * lr_final_frac)
            self.opt = optim.Adam(learning_rate=sched)  # rebuild with the schedule

        def loss_fn(model: RenderModel, o: mx.array, d: mx.array, gt: mx.array, key: mx.array) -> mx.array:
            return model.render_loss(o, d, gt, key)

        loss_and_grad = nn.value_and_grad(self.model, loss_fn)
        full_batch = rays_per_batch >= m  # a batch covering the whole set = the whole set: exact
        # gradients, and the trajectory no longer depends on the batch-index draws at all.
        for i in range(iters):
            if full_batch:
                o, d, gt = origins, directions, target_rgb
            else:
                idx = mx.array(rng.integers(0, m, size=rays_per_batch).astype(np.int32))
                o, d, gt = (
                    mx.take(origins, idx, axis=0),
                    mx.take(directions, idx, axis=0),
                    mx.take(target_rgb, idx, axis=0),
                )
            _, grads = loss_and_grad(self.model, o, d, gt, keys[i])
            if grad_clip is not None:
                grads, _ = optim.clip_grad_norm(grads, grad_clip)  # cap explosion before the step
            self.opt.update(self.model, grads)
            mx.eval(self.model.parameters(), self.opt.state)
        return self.model
