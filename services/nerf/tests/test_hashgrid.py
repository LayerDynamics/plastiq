"""N7 — multiresolution hash-grid encoding (instant-NGP) in MLX, and a NeRF that trains with it."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.engine.trainer import Trainer  # noqa: E402
from app.field_components.encodings import HashGridEncoding  # noqa: E402
from app.models.vanilla_nerf import VanillaNeRF  # noqa: E402
from app.utils.config import FieldConfig, NerfConfig, SamplerConfig  # noqa: E402
from app.data_processing.rays import generate_rays  # noqa: E402
from app.utils.seeding import make_key  # noqa: E402
from tests.synthetic import make_synthetic_dataset  # noqa: E402


def test_hashgrid_output_dim_and_distinctness():
    enc = HashGridEncoding(n_levels=8, features_per_level=2, seed=0)
    assert enc.output_dim == 16
    out = np.asarray(enc(mx.array([[0.1, -0.2, 0.3], [0.8, 0.5, -0.9]])))
    assert out.shape == (2, 16)
    assert not np.allclose(out[0], out[1])  # distinct inputs → distinct features


def test_hashgrid_deterministic():
    x = mx.array([[0.4, 0.4, 0.4]])
    a = np.asarray(HashGridEncoding(seed=3)(x))
    b = np.asarray(HashGridEncoding(seed=3)(x))
    assert np.allclose(a, b)


def _rays(views, imgs, poses, intr):
    o_, d_, t_ = [], [], []
    for v in views:
        o, d = generate_rays(poses[v], intr["fx"], intr["fy"], intr["cx"], intr["cy"], intr["height"], intr["width"])
        o_.append(o)
        d_.append(d)
        t_.append(mx.array(imgs[v].reshape(-1, 3).astype(np.float32)))
    return mx.concatenate(o_), mx.concatenate(d_), mx.concatenate(t_)


def _psnr(p, g):
    return -10.0 * np.log10(max(float(np.mean((np.asarray(p) - np.asarray(g)) ** 2)), 1e-10))


def test_nerf_with_hashgrid_trains():
    imgs, poses, intr, _ = make_synthetic_dataset(n_views=6, h=20, w=20)
    to, td, tt = _rays([0, 1, 2, 3, 4], imgs, poses, intr)
    ho, hd, ht = _rays([5], imgs, poses, intr)
    cfg = NerfConfig(
        field=FieldConfig(hidden=64, layers=3, use_hashgrid=True, aabb=(-1.5, 1.5)),
        sampler=SamplerConfig(n_samples=32, near=2.0, far=4.5),
    )
    model = VanillaNeRF(cfg, seed=0)
    before = _psnr(model.render_rays(ho, hd, key=make_key(9)), ht)
    Trainer(model, lr=5e-3, seed=0).train(to, td, tt, iters=300, rays_per_batch=512)
    after = _psnr(model.render_rays(ho, hd, key=make_key(9)), ht)
    assert after > before + 2.0, f"hash-grid NeRF PSNR {before:.2f} → {after:.2f} dB"
