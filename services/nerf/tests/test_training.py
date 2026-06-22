"""N6 — REAL MLX NeRF training on the M4 Max: train on 5 synthetic views, assert the held-out (novel)
view's PSNR improves substantially. Not a stub — the field actually learns the 3D scene."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.data_processing.rays import generate_rays  # noqa: E402
from app.engine.trainer import Trainer  # noqa: E402
from app.models.vanilla_nerf import VanillaNeRF  # noqa: E402
from app.utils.config import FieldConfig, NerfConfig, SamplerConfig  # noqa: E402
from app.utils.seeding import make_key  # noqa: E402
from tests.synthetic import make_synthetic_dataset  # noqa: E402


def _rays_for_views(views, imgs, poses, intr):
    o_, d_, t_ = [], [], []
    for v in views:
        o, d = generate_rays(poses[v], intr["fx"], intr["fy"], intr["cx"], intr["cy"], intr["height"], intr["width"])
        o_.append(o)
        d_.append(d)
        t_.append(mx.array(imgs[v].reshape(-1, 3).astype(np.float32)))
    return mx.concatenate(o_), mx.concatenate(d_), mx.concatenate(t_)


def _psnr(pred, gt) -> float:
    mse = float(np.mean((np.asarray(pred) - np.asarray(gt)) ** 2))
    return -10.0 * np.log10(max(mse, 1e-10))


def test_nerf_training_improves_held_out_psnr():
    imgs, poses, intr, _ = make_synthetic_dataset(n_views=6, h=20, w=20)
    train_o, train_d, train_t = _rays_for_views([0, 1, 2, 3, 4], imgs, poses, intr)
    ho_o, ho_d, ho_t = _rays_for_views([5], imgs, poses, intr)  # held-out novel view

    cfg = NerfConfig(
        field=FieldConfig(n_frequencies=6, hidden=64, layers=4),
        sampler=SamplerConfig(n_samples=32, near=2.0, far=4.5),
    )
    model = VanillaNeRF(cfg, seed=0)
    before = _psnr(model.render_rays(ho_o, ho_d, key=make_key(99)), ho_t)

    Trainer(model, lr=5e-3, seed=0).train(train_o, train_d, train_t, iters=300, rays_per_batch=512)

    after = _psnr(model.render_rays(ho_o, ho_d, key=make_key(99)), ho_t)
    assert after > before + 2.0, f"PSNR did not improve enough: {before:.2f} → {after:.2f} dB"
