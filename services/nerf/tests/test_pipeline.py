"""N10 — the train→export pipeline end to end (no HTTP): transforms.json + images → trained MLX
field → marching-cubes mesh → GLB. This is the real work the `/train` job runs; testing it directly
exercises the whole stack (parse → rays → train → extract → glb) on the M4 Max without a web server."""

import base64

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")
pytest.importorskip("skimage.measure")
pytest.importorskip("trimesh")

from app.engine.pipeline import train_and_export  # noqa: E402
from tests.synthetic import make_synthetic_dataset  # noqa: E402


def test_train_and_export_neus_produces_a_real_glb_mesh():
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=6, h=16, w=16)
    result = train_and_export(transforms, imgs, method="neus", iters=120, grid_res=24, seed=0)

    assert result["method"] == "neus"
    assert result["iters"] == 120
    assert result["vertices"] > 0 and result["faces"] > 0
    assert result["psnr"] > 0.0  # a finite training-quality score
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


def test_train_and_export_rejects_mismatched_image_count():
    imgs, _poses, _intr, transforms = make_synthetic_dataset(n_views=4, h=16, w=16)
    with pytest.raises(ValueError, match="poses but"):
        train_and_export(transforms, np.asarray(imgs[:3]), method="neus", iters=10, grid_res=16)
