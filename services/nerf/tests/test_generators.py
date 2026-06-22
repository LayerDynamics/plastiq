"""N2 — generators: uniform + PDF (importance) ray samplers (MLX)."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.generators.ray_samplers import PDFSampler, UniformSampler  # noqa: E402
from app.utils.seeding import make_key  # noqa: E402


def test_uniform_sampler_monotonic_within_bounds():
    s = UniformSampler(n_samples=16, near=0.1, far=4.0)
    origins = mx.zeros((5, 3))
    dirs = mx.broadcast_to(mx.array([0.0, 0.0, 1.0]), (5, 3))
    pos, t = s(origins, dirs)
    t, pos = np.asarray(t), np.asarray(pos)
    assert t.shape == (5, 16)
    assert pos.shape == (5, 16, 3)
    assert np.all(t >= 0.1) and np.all(t <= 4.0)
    assert np.all(np.diff(t, axis=1) > 0)  # strictly increasing along each ray
    assert np.allclose(pos[..., 2], t, atol=1e-5)  # origin 0 + t·(+z) → z == t


def test_uniform_jitter_is_deterministic_and_in_bounds():
    s = UniformSampler(n_samples=8, near=0.0, far=2.0, jitter=True)
    o = mx.zeros((3, 3))
    d = mx.broadcast_to(mx.array([0.0, 0.0, 1.0]), (3, 3))
    _, t1 = s(o, d, key=make_key(0))
    _, t2 = s(o, d, key=make_key(0))
    t1, t2 = np.asarray(t1), np.asarray(t2)
    assert np.array_equal(t1, t2)  # same key → identical jitter
    assert np.all(t1 >= 0.0) and np.all(t1 <= 2.0)


def test_pdf_sampler_concentrates_on_the_weight_peak():
    s = PDFSampler(n_samples=64)
    t = mx.array([[0.0, 1.0, 2.0, 3.0, 4.0]])
    weights = mx.array([[0.0, 0.0, 1.0, 0.0, 0.0]])  # all weight on bin 2 (t=2.0)
    ts = np.asarray(s(t, weights, key=make_key(0)))
    assert ts.shape == (1, 64)
    assert np.all(np.isclose(ts, 2.0))  # one-hot CDF → every sample lands at t=2.0
