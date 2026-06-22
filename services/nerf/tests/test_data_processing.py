"""N5 — ray generation, transforms.json parsing, and the synthetic ground-truth fixture."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.data_processing.dataparser import parse_transforms  # noqa: E402
from app.data_processing.rays import generate_rays  # noqa: E402
from tests.synthetic import look_at, make_synthetic_dataset  # noqa: E402


def test_generate_rays_center_and_origin():
    c2w = look_at(eye=(0.0, 0.0, 3.0), target=(0.0, 0.0, 0.0))  # camera at +3z looking at origin
    o, d = generate_rays(c2w, fx=20.0, fy=20.0, cx=11.5, cy=11.5, height=24, width=24)
    o, d = np.asarray(o), np.asarray(d)
    assert o.shape == (24 * 24, 3) and d.shape == (24 * 24, 3)
    # the principal-point pixel (cx,cy) ~ index near the centre → its ray points from eye toward origin (−z)
    centre = int((11 * 24) + 11)
    assert np.allclose(o[centre], [0.0, 0.0, 3.0], atol=1e-4)  # origin == camera position
    forward = np.array([0.0, 0.0, -1.0])  # toward the origin from +z
    assert np.dot(d[centre], forward) > 0.99  # the centre ray looks at the target


def test_parse_transforms_recovers_intrinsics_and_poses():
    _, poses, intr, transforms = make_synthetic_dataset(n_views=4, h=16, w=16)
    out = parse_transforms(transforms)
    assert out.fx == pytest.approx(intr["fx"]) and out.cx == pytest.approx(intr["cx"])
    assert out.width == 16 and out.height == 16
    assert out.poses.shape == (4, 4, 4)
    assert np.allclose(out.poses, poses, atol=1e-5)


def test_synthetic_scene_renders_nontrivial_and_deterministic():
    imgs, poses, _, _ = make_synthetic_dataset(n_views=6, h=24, w=24)
    assert imgs.shape == (6, 24, 24, 3)
    # each view sees the sphere (some non-background pixels) but not the whole frame
    fg = (imgs.reshape(6, -1, 3).sum(axis=-1) > 0).mean(axis=1)  # foreground fraction per view
    assert np.all(fg > 0.05) and np.all(fg < 0.95)
    # different views differ (real 3D structure), and the render is reproducible
    assert not np.allclose(imgs[0], imgs[3])
    imgs2, _, _, _ = make_synthetic_dataset(n_views=6, h=24, w=24)
    assert np.array_equal(imgs, imgs2)
