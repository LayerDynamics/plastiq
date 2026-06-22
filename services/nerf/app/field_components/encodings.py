"""Input encodings (N1, N7). MLX. FrequencyEncoding now; HashGridEncoding lands in N7."""

from __future__ import annotations

import mlx.core as mx


class FrequencyEncoding:
    """Sinusoidal positional encoding (NeRF): `[x, sin(2^k x), cos(2^k x)]` for k in 0..L-1. Lifts a
    low-dim coordinate into a high-frequency feature so the MLP can fit sharp geometry/colour."""

    def __init__(self, n_frequencies: int = 6, include_input: bool = True):
        self.n_frequencies = n_frequencies
        self.include_input = include_input
        self._freqs = mx.array([float(2**i) for i in range(n_frequencies)], dtype=mx.float32)  # (L,)

    def output_dim(self, in_dim: int) -> int:
        return in_dim * ((1 if self.include_input else 0) + 2 * self.n_frequencies)

    def __call__(self, x: mx.array) -> mx.array:
        xb = x[..., None] * self._freqs  # (..., D, L)
        enc = mx.concatenate([mx.sin(xb), mx.cos(xb)], axis=-1)  # (..., D, 2L)
        enc = enc.reshape(*x.shape[:-1], x.shape[-1] * 2 * self.n_frequencies)
        if self.include_input:
            enc = mx.concatenate([x, enc], axis=-1)
        return enc
