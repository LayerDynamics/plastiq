"""T39 — sparse_max_dim: register at reduced res, densify at full native resolution.

Pipeline already supports ``dense_images`` (ComparativeDeepDive fix). This module pins the
HTTP-shell wiring: ``SolveBody.sparse_max_dim`` is accepted, and ``_load_pipeline_solve``
downscales sparse inputs while forwarding full-res frames as ``dense_images``.
"""

from __future__ import annotations

import base64
import io
from unittest.mock import patch

import pytest
from PIL import Image

from app.main import SolveBody, _load_pipeline_solve


def _rgb_jpeg_b64(w: int, h: int, color=(40, 80, 120)) -> str:
    img = Image.new("RGB", (w, h), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_solve_body_accepts_sparse_max_dim():
    body = SolveBody(
        images=[_rgb_jpeg_b64(64, 48)] * 3,
        sparse_max_dim=640,
    )
    assert body.sparse_max_dim == 640


def test_solve_body_rejects_sparse_max_dim_out_of_bounds():
    with pytest.raises(Exception):
        SolveBody(images=[_rgb_jpeg_b64(64, 48)] * 3, sparse_max_dim=128)
    with pytest.raises(Exception):
        SolveBody(images=[_rgb_jpeg_b64(64, 48)] * 3, sparse_max_dim=5000)


def test_load_pipeline_solve_downscales_sparse_and_forwards_full_dense():
    """When sparse_max_dim < native longest side, sparse gets downscaled; dense_images = full."""
    captured: dict = {}

    class _FakeRes:
        transforms_json = "{}"
        sparse_ply = "ply\n"
        dense_ply = None
        report = {"images_total": 3, "dense_points": 0}

    def fake_solve(images, **kwargs):
        captured["images"] = images
        captured["kwargs"] = kwargs
        return _FakeRes()

    # 1600×1200 uploads; sparse_max_dim=640 → sparse longest side 640.
    payload = {
        "images": [_rgb_jpeg_b64(1600, 1200)] * 3,
        "dense": True,
        "matching": "exhaustive",
        "max_features": 4096,
        "seed": 0,
        "sparse_max_dim": 640,
    }
    import app.pipeline as pipeline_mod

    with patch.object(pipeline_mod, "solve", fake_solve):
        out = _load_pipeline_solve(payload)

    assert "transforms_json" in out
    sparse = captured["images"]
    dense = captured["kwargs"].get("dense_images")
    assert dense is not None
    assert len(sparse) == 3 and len(dense) == 3
    # sparse longest side ≤ 640
    for im in sparse:
        assert max(im.shape[0], im.shape[1]) == 640
    # dense stays native 1200×1600 (H,W)
    for im in dense:
        assert im.shape[0] == 1200 and im.shape[1] == 1600


def test_load_pipeline_solve_no_dense_images_when_already_small():
    """When uploads already fit under sparse_max_dim, dense_images is None (same-res path)."""
    captured: dict = {}

    class _FakeRes:
        transforms_json = "{}"
        sparse_ply = "ply\n"
        dense_ply = None
        report = {"images_total": 3, "dense_points": 0}

    def fake_solve(images, **kwargs):
        captured["images"] = images
        captured["kwargs"] = kwargs
        return _FakeRes()

    payload = {
        "images": [_rgb_jpeg_b64(320, 240)] * 3,
        "dense": True,
        "matching": "exhaustive",
        "max_features": 4096,
        "seed": 0,
        "sparse_max_dim": 640,
    }
    import app.pipeline as pipeline_mod

    with patch.object(pipeline_mod, "solve", fake_solve):
        _load_pipeline_solve(payload)

    assert captured["kwargs"].get("dense_images") is None
    for im in captured["images"]:
        assert im.shape[0] == 240 and im.shape[1] == 320
