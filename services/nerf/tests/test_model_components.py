"""N3 — model_components: volumetric renderer + losses (MLX)."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.model_components.losses import eikonal_loss, mse_loss  # noqa: E402
from app.model_components.renderers import volumetric_render  # noqa: E402


def test_render_opaque_front_sample_dominates():
    # 1 ray, 4 samples; the first is very dense and red — it should own the pixel.
    densities = mx.array([[1e3, 0.0, 0.0, 0.0]])
    colors = mx.array([[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 1.0]]])
    t = mx.array([[0.1, 0.2, 0.3, 0.4]])
    out = volumetric_render(densities, colors, t)
    rgb = np.asarray(out["rgb"])[0]
    acc = float(np.asarray(out["accumulation"])[0])
    assert np.allclose(rgb, [1.0, 0.0, 0.0], atol=1e-3)  # the red front sample
    assert 0.99 < acc <= 1.0


def test_render_empty_is_background():
    densities = mx.zeros((2, 5))
    colors = mx.ones((2, 5, 3))
    t = mx.broadcast_to(mx.linspace(0.1, 1.0, 5)[None, :], (2, 5))
    out = volumetric_render(densities, colors, t)
    assert np.allclose(np.asarray(out["accumulation"]), 0.0, atol=1e-5)  # nothing hit
    assert np.allclose(np.asarray(out["rgb"]), 0.0, atol=1e-5)  # → black background
    # weights sum to the accumulation, always in [0,1]
    w = np.asarray(out["weights"])
    assert np.all(w >= -1e-6) and np.all(w.sum(axis=1) <= 1.0 + 1e-5)


def test_mse_loss():
    a = mx.ones((4, 3))
    assert float(mse_loss(a, a)) == 0.0
    assert float(mse_loss(a, mx.zeros((4, 3)))) == pytest.approx(1.0)


def test_eikonal_loss_zero_on_unit_gradients():
    g = mx.broadcast_to(mx.array([1.0, 0.0, 0.0]), (10, 3))
    assert float(eikonal_loss(g)) == pytest.approx(0.0, abs=1e-6)
    g2 = mx.broadcast_to(mx.array([2.0, 0.0, 0.0]), (10, 3))  # |g|=2 → (2-1)^2 = 1
    assert float(eikonal_loss(g2)) == pytest.approx(1.0, abs=1e-5)
