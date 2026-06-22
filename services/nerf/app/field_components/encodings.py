"""Input encodings (N1, N7). MLX. FrequencyEncoding now; HashGridEncoding lands in N7."""

from __future__ import annotations

import math

import mlx.core as mx
import mlx.nn as nn


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


class HashGridEncoding(nn.Module):
    """Multiresolution hash encoding (instant-NGP, Müller et al.) in MLX. A point is normalized into
    the scene AABB, and at each of L geometric resolution levels its 8 surrounding grid corners are
    spatially hashed into a small learnable feature table and trilinearly interpolated. The L·F
    features let a tiny MLP fit sharp detail far faster than frequency encoding.

    The feature tables are learnable parameters (tracked by nn.Module). The hash primes/resolutions
    are plain Python (not mx.array attributes) so they are NOT mistaken for trainable parameters.
    """

    def __init__(
        self,
        n_levels: int = 8,
        features_per_level: int = 2,
        table_size: int = 2**14,
        n_min: int = 16,
        n_max: int = 256,
        aabb: tuple[float, float] = (-1.5, 1.5),
        seed: int = 0,
    ):
        super().__init__()
        self.n_levels = n_levels
        self.features_per_level = features_per_level
        self.table_size = table_size
        self.aabb_min, self.aabb_max = float(aabb[0]), float(aabb[1])
        growth = math.exp((math.log(n_max) - math.log(n_min)) / max(1, n_levels - 1))
        self.resolutions = [int(round(n_min * (growth**level))) for level in range(n_levels)]
        self._primes = (1, 19349663, 83492791)  # plain tuple → not a tracked parameter
        mx.random.seed(seed)
        # one learnable feature table per level (small init, as in instant-NGP)
        self.tables = [
            mx.random.uniform(-1e-4, 1e-4, (table_size, features_per_level)) for _ in range(n_levels)
        ]

    @property
    def output_dim(self) -> int:
        return self.n_levels * self.features_per_level

    def _hash(self, coords: mx.array) -> mx.array:
        """Integer corner coords `(N,3)` → table indices `(N,)` via a linear spatial hash (int64,
        no overflow/xor needed)."""
        primes = mx.array(self._primes, dtype=mx.int64)
        return mx.sum(coords.astype(mx.int64) * primes, axis=1) % self.table_size

    def __call__(self, x: mx.array) -> mx.array:
        xn = mx.clip((x - self.aabb_min) / (self.aabb_max - self.aabb_min), 0.0, 1.0)  # (N,3) → [0,1]
        feats = []
        for level, res in enumerate(self.resolutions):
            xl = xn * res
            x0 = mx.floor(xl)
            w = xl - x0  # (N,3) fractional offset
            acc = mx.zeros((x.shape[0], self.features_per_level))
            for corner in range(8):
                ox, oy, oz = corner & 1, (corner >> 1) & 1, (corner >> 2) & 1
                ci = x0 + mx.array([ox, oy, oz], dtype=mx.float32)
                f = mx.take(self.tables[level], self._hash(ci), axis=0)  # (N,F)
                wx = w[:, 0] if ox else (1.0 - w[:, 0])
                wy = w[:, 1] if oy else (1.0 - w[:, 1])
                wz = w[:, 2] if oz else (1.0 - w[:, 2])
                acc = acc + f * (wx * wy * wz)[:, None]
            feats.append(acc)
        return mx.concatenate(feats, axis=-1)
