"""N1 — field_components: frequency encoding, MLP, density/RGB heads (MLX nn building blocks)."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.field_components.encodings import FrequencyEncoding  # noqa: E402
from app.field_components.field_heads import DensityHead, RGBHead  # noqa: E402
from app.field_components.mlp import MLP  # noqa: E402
from app.utils.seeding import make_key  # noqa: E402


def test_frequency_encoding_output_dim():
    enc = FrequencyEncoding(n_frequencies=4, include_input=True)
    out = enc(mx.zeros((10, 3)))
    assert out.shape == (10, 3 * (1 + 2 * 4))  # include_input + sin/cos per band = 27
    assert enc.output_dim(3) == 27


def test_frequency_encoding_known_values():
    enc = FrequencyEncoding(n_frequencies=1, include_input=True)
    out = np.asarray(enc(mx.array([[0.0]])))  # x=0 → [x, sin(0)=0, cos(0)=1]
    assert out.shape == (1, 3)
    assert np.allclose(out[0], [0.0, 0.0, 1.0], atol=1e-6)


def test_mlp_forward_shape():
    mlp = MLP(in_dim=27, hidden=64, out_dim=16, layers=3)
    assert mlp(mx.zeros((5, 27))).shape == (5, 16)


def test_density_head_is_nonnegative():
    head = DensityHead(in_dim=16)
    d = np.asarray(head(mx.random.normal((20, 16), key=make_key(0))))
    assert d.shape == (20, 1)
    assert np.all(d >= 0.0)  # density activation (softplus) → non-negative


def test_rgb_head_in_unit_range():
    head = RGBHead(in_dim=16)
    c = np.asarray(head(mx.random.normal((20, 16), key=make_key(1))))
    assert c.shape == (20, 3)
    assert np.all((c >= 0.0) & (c <= 1.0))  # sigmoid → [0,1]
