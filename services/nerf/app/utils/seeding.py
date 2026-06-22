"""Deterministic MLX seeding (NFR-1). Explicit keys, so the same seed always reproduces the same
random draws — sampling, init, ray jitter — and the training tests are reproducible."""

from __future__ import annotations

import mlx.core as mx


def make_key(seed: int) -> mx.array:
    """A PRNG key from an integer seed (masked to 32 bits)."""
    return mx.random.key(int(seed) & 0xFFFFFFFF)


def split_keys(seed: int, n: int) -> mx.array:
    """`n` independent sub-keys derived from `seed` (shape `(n, 2)`). Use one per random op so draws
    don't accidentally correlate."""
    return mx.random.split(make_key(seed), n)
