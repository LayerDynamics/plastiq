"""N4 — fields: the NeRF density+color field (MLX), composed from field_components."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.fields.vanilla_nerf_field import NeRFField  # noqa: E402
from app.utils.config import FieldConfig  # noqa: E402


def test_nerf_field_forward_shapes_and_ranges():
    f = NeRFField(FieldConfig(n_frequencies=6, hidden=64, layers=4), seed=0)
    pos = mx.zeros((32, 3))
    d = mx.broadcast_to(mx.array([0.0, 0.0, 1.0]), (32, 3))
    density, rgb = f(pos, d)
    density, rgb = np.asarray(density), np.asarray(rgb)
    assert density.shape == (32, 1)
    assert rgb.shape == (32, 3)
    assert np.all(density >= 0.0)
    assert np.all((rgb >= 0.0) & (rgb <= 1.0))


def test_nerf_field_init_is_deterministic():
    cfg = FieldConfig()
    a = NeRFField(cfg, seed=5)
    b = NeRFField(cfg, seed=5)
    pos = mx.random.normal((10, 3), key=mx.random.key(0))
    d = mx.broadcast_to(mx.array([0.0, 0.0, 1.0]), (10, 3))
    da, _ = a(pos, d)
    db, _ = b(pos, d)
    assert np.allclose(np.asarray(da), np.asarray(db))
