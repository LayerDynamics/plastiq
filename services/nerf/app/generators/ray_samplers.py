"""Ray samplers (N2, MLX): where along each ray to evaluate the field.

`UniformSampler` places evenly-spaced samples between near/far (optionally stratified-jittered);
`PDFSampler` resamples from a coarse weight distribution (importance/hierarchical sampling) so the fine
pass concentrates samples on the surface. Deterministic via explicit MLX keys.
"""

from __future__ import annotations

import mlx.core as mx


class UniformSampler:
    def __init__(self, n_samples: int, near: float, far: float, jitter: bool = False):
        self.n_samples = n_samples
        self.near = near
        self.far = far
        self.jitter = jitter

    def __call__(self, origins: mx.array, directions: mx.array, key: mx.array | None = None):
        """origins/directions `(R,3)` → (positions `(R,S,3)`, t `(R,S)`)."""
        r = origins.shape[0]
        t = mx.broadcast_to(mx.linspace(self.near, self.far, self.n_samples)[None, :], (r, self.n_samples))
        if self.jitter and key is not None:
            bin_w = (self.far - self.near) / (self.n_samples - 1)
            t = mx.clip(t + (mx.random.uniform(shape=(r, self.n_samples), key=key) - 0.5) * bin_w, self.near, self.far)
        positions = origins[:, None, :] + t[:, :, None] * directions[:, None, :]
        return positions, t


class PDFSampler:
    def __init__(self, n_samples: int):
        self.n_samples = n_samples

    def __call__(self, t: mx.array, weights: mx.array, key: mx.array) -> mx.array:
        """Inverse-CDF resample `n_samples` t-values from the per-ray `weights` over bins `t` `(R,S)`.
        MLX has no `searchsorted`, so the bin index is `count(cdf < u)`. Returns `(R, n_samples)`."""
        s = weights.shape[-1]
        pdf = weights / (mx.sum(weights, axis=-1, keepdims=True) + 1e-8)
        cdf = mx.cumsum(pdf, axis=-1)  # (R, S)
        u = mx.random.uniform(shape=(weights.shape[0], self.n_samples), key=key)  # (R, N)
        idx = mx.clip(mx.sum((u[..., None] > cdf[:, None, :]).astype(mx.int32), axis=-1), 0, s - 1)  # (R, N)
        return mx.take_along_axis(t, idx, axis=-1)
