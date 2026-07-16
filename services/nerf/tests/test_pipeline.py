"""N10 — the train→export pipeline end to end (no HTTP): transforms.json + images → trained MLX
field → marching-cubes mesh → GLB. This is the real work the `/train` job runs; testing it directly
exercises the whole stack (parse → rays → train → extract → glb) on the M4 Max without a web server."""

import base64

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")
pytest.importorskip("skimage.measure")
pytest.importorskip("trimesh")

import app.engine.pipeline as pipeline_mod  # noqa: E402
from app.engine.pipeline import _holdout_split, train_and_export  # noqa: E402
from app.field_components.encodings import FrequencyEncoding, HashGridEncoding  # noqa: E402
from app.models.neus import VolSDFModel  # noqa: E402
from app.models.vanilla_nerf import VanillaNeRF  # noqa: E402
from tests.synthetic import make_synthetic_dataset  # noqa: E402


def test_train_and_export_neus_produces_a_real_glb_mesh():
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=6, h=16, w=16)
    result = train_and_export(transforms, imgs, method="neus", iters=120, grid_res=24, seed=0)

    assert result["method"] == "neus"
    assert result["iters"] == 120
    assert result["vertices"] > 0 and result["faces"] > 0
    assert np.isfinite(result["psnr"]) and result["psnr"] > 0.0  # a finite held-out quality score
    glb = base64.b64decode(result["glb_base64"])
    assert len(glb) > 0 and glb[:4] == b"glTF"  # a real binary glTF container


def test_train_and_export_nerf_density_path_produces_a_mesh():
    # The density-NeRF path (method="nerf") goes through extract_density_mesh at the fixed iso level —
    # exercise it end-to-end so both models are covered (not just VolSDF). For an arbitrary scene the
    # density threshold may need tuning; the unit-scaled synthetic sphere crosses the default.
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=6, h=16, w=16)
    result = train_and_export(transforms, imgs, method="nerf", iters=150, grid_res=24, seed=0)

    assert result["method"] == "nerf"
    assert result["vertices"] > 0 and result["faces"] > 0
    glb = base64.b64decode(result["glb_base64"])
    assert len(glb) > 0 and glb[:4] == b"glTF"


class _TrainReached(Exception):
    """Sentinel: the spy captured the model the pipeline was about to train."""


def _capture_pipeline_model(monkeypatch, **kwargs):
    """Run `train_and_export` up to the training call and return the model it constructed — the
    genuinely-served object, so tests assert on the encoder/sampler types, not on a payload echo."""
    captured = []

    def spy(self, *a, **k):
        captured.append(self.model)
        raise _TrainReached

    monkeypatch.setattr(pipeline_mod.Trainer, "train", spy)
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=4, h=8, w=8)
    with pytest.raises(_TrainReached):
        train_and_export(transforms, imgs, iters=10, grid_res=16, seed=0, **kwargs)
    assert len(captured) == 1
    return captured[0]


def test_pipeline_wires_encoding_and_importance_into_the_served_model(monkeypatch):
    # 11-L1: encoding/importance genuinely change the model /train serves (config → constructed model).
    model = _capture_pipeline_model(monkeypatch, method="nerf", encoding="hashgrid", importance_samples=8)
    assert isinstance(model, VanillaNeRF)
    assert isinstance(model.field.pos_enc, HashGridEncoding)  # the encoder actually flipped
    assert model.importance_samples == 8
    assert model.pdf_sampler is not None and model.pdf_sampler.n_samples == 8  # fine pass is live

    # Nerf defaults: frequency encoding, coarse-only sampling.
    model = _capture_pipeline_model(monkeypatch, method="nerf")
    assert isinstance(model.field.pos_enc, FrequencyEncoding)
    assert model.importance_samples == 0 and model.pdf_sampler is None

    # Neus production default enables hierarchical PDF (T28 proposal-style fine pass).
    model = _capture_pipeline_model(monkeypatch, method="neus")
    assert isinstance(model, VolSDFModel)
    assert model.pdf_sampler is not None and model.importance_samples == 32

    # Explicit importance sampling is supported by BOTH methods.
    model = _capture_pipeline_model(monkeypatch, method="neus", importance_samples=4)
    assert isinstance(model, VolSDFModel)
    assert model.pdf_sampler is not None and model.pdf_sampler.n_samples == 4


def test_train_and_export_rejects_hashgrid_with_neus():
    # The neus SDF trunk consumes raw coordinates by design — hashgrid there would be silently
    # ignored, so the pipeline refuses it (mirrors the API-level 422).
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=2, h=8, w=8)
    with pytest.raises(ValueError, match="requires method 'nerf'"):
        train_and_export(transforms, imgs, method="neus", encoding="hashgrid", iters=10, grid_res=16)
    with pytest.raises(ValueError, match="unknown encoding"):
        train_and_export(transforms, imgs, method="nerf", encoding="fourier", iters=10, grid_res=16)
    with pytest.raises(ValueError, match="importance_samples"):
        train_and_export(transforms, imgs, method="nerf", importance_samples=-1, iters=10, grid_res=16)


def test_train_and_export_rejects_mismatched_image_count():
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=4, h=16, w=16)
    with pytest.raises(ValueError, match="poses but"):
        train_and_export(transforms, np.asarray(imgs[:3]), method="neus", iters=10, grid_res=16)


def test_holdout_split_is_disjoint_deterministic_and_seeded():
    # The reported PSNR is only honest if the held-out rays are (a) chosen before training, (b) truly
    # excluded from the training indices, and (c) reproducible for a given seed.
    m = 6 * 16 * 16  # the ray count of the 6-view 16×16 dataset above
    train, hold = _holdout_split(m, seed=0)
    train2, hold2 = _holdout_split(m, seed=0)
    assert np.array_equal(train, train2) and np.array_equal(hold, hold2)  # deterministic per seed

    assert len(hold) == min(4096, m // 10)  # ~10% held out, capped
    assert len(train) + len(hold) == m  # a partition of all rays…
    assert np.intersect1d(train, hold).size == 0  # …with no leakage into training
    assert np.union1d(train, hold).size == m

    _, hold_other = _holdout_split(m, seed=7)
    assert not np.array_equal(hold, hold_other)  # the seed actually drives the draw

    # Degenerate sizes stay safe: at least 1 held out when m > 1, never the whole set.
    train_tiny, hold_tiny = _holdout_split(2, seed=0)
    assert len(hold_tiny) == 1 and len(train_tiny) == 1
