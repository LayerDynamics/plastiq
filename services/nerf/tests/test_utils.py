"""N0.3 — utils: deterministic MLX seeding, config dataclasses, safe math. See docs/plans/2026-06-22-nerf-service.md."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.utils.config import NerfConfig, TrainConfig  # noqa: E402
from app.utils.math import safe_normalize  # noqa: E402
from app.utils.seeding import make_key, split_keys  # noqa: E402


def test_seeding_is_deterministic():
    a = mx.random.uniform(shape=(5,), key=make_key(7))
    b = mx.random.uniform(shape=(5,), key=make_key(7))
    assert np.array_equal(np.asarray(a), np.asarray(b))  # same seed → identical draw
    c = mx.random.uniform(shape=(5,), key=make_key(8))
    assert not np.array_equal(np.asarray(a), np.asarray(c))  # different seed → different


def test_split_keys_count():
    ks = split_keys(0, 4)
    assert ks.shape[0] == 4
    # the sub-keys are distinct
    assert not np.array_equal(np.asarray(ks[0]), np.asarray(ks[1]))


def test_safe_normalize_unit_and_zero():
    n = np.asarray(safe_normalize(mx.array([[3.0, 0.0, 0.0], [0.0, 0.0, 0.0]])))
    assert np.allclose(n[0], [1.0, 0.0, 0.0])
    assert np.all(np.isfinite(n[1]))  # zero vector must not produce NaN
    assert np.allclose(n[1], [0.0, 0.0, 0.0])


def test_config_defaults_and_override():
    c = NerfConfig()
    assert c.sampler.n_samples > 0
    assert c.train.iters > 0
    c2 = NerfConfig(train=TrainConfig(iters=10, seed=3))
    assert c2.train.iters == 10
    assert c2.train.seed == 3
    # nested defaults are independent instances (default_factory, not shared mutable)
    assert NerfConfig().field is not NerfConfig().field
