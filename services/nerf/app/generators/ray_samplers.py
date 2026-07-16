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


class ProposalSampler:
    """Two-stage sampling schedule (T28 / ComparativeDeepDive §4.2 #3).

    Coarse uniform samples act as a density *proposal*; a fine PDF pass
    (`PDFSampler`) concentrates samples near the surface. This mirrors
    nerfstudio's ProposalNetworkSampler shape without a separate density MLP —
    the coarse field evaluation supplies the proposal weights (see
    `BaseSurfaceModel._render`).
    """

    def __init__(self, n_coarse: int, n_fine: int, near: float, far: float, jitter: bool = True):
        self.coarse = UniformSampler(n_coarse, near, far, jitter=jitter)
        self.fine = PDFSampler(n_fine)
        self.n_coarse = n_coarse
        self.n_fine = n_fine

    def sample_coarse(self, origins: mx.array, directions: mx.array, key: mx.array | None = None):
        return self.coarse(origins, directions, key=key)

    def sample_fine(self, t: mx.array, weights: mx.array, key: mx.array) -> mx.array:
        return self.fine(t, weights, key)


class PDFSampler:
    def __init__(self, n_samples: int):
        self.n_samples = n_samples

    def __call__(self, t: mx.array, weights: mx.array, key: mx.array) -> mx.array:
        """Inverse-CDF importance resampling (NeRF `sample_pdf`) over bins `t`/`weights` `(R,S)` →
        `(R, n_samples)`. The bin is found from the CDF (MLX has no `searchsorted`, so it is
        `count(cdf ≤ u)`), then the sample is **linearly interpolated WITHIN that bin** — so fine
        samples land between the coarse `t`'s (concentrated where weight is high) instead of snapping
        to coarse edges (which would just re-query existing points)."""
        r, s = weights.shape
        pdf = weights / (mx.sum(weights, axis=-1, keepdims=True) + 1e-8)
        cdf = mx.cumsum(pdf, axis=-1)  # (R, S), cdf[...,-1] ≈ 1
        cdf = mx.concatenate([mx.zeros((r, 1)), cdf], axis=-1)  # (R, S+1), lower edge 0
        u = mx.random.uniform(shape=(r, self.n_samples), key=key)  # (R, N)
        # interval index i ∈ [0, S-1]: (number of CDF edges ≤ u) − 1, clamped
        i = mx.clip(mx.sum((cdf[:, None, :] <= u[:, :, None]).astype(mx.int32), axis=-1) - 1, 0, s - 1)
        cdf_lo = mx.take_along_axis(cdf, i, axis=-1)  # (R, N)
        cdf_hi = mx.take_along_axis(cdf, i + 1, axis=-1)
        denom = cdf_hi - cdf_lo
        frac = (u - cdf_lo) / mx.where(denom < 1e-8, mx.ones_like(denom), denom)  # bin-local fraction
        t_lo = mx.take_along_axis(t, i, axis=-1)
        t_hi = mx.take_along_axis(t, mx.clip(i + 1, 0, s - 1), axis=-1)
        return t_lo + frac * (t_hi - t_lo)
