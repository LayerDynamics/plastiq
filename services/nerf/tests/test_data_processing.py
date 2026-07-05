"""N5 — ray generation, transforms.json parsing, and the synthetic ground-truth fixture."""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.data_processing.dataparser import parse_transforms  # noqa: E402
from app.data_processing.rays import generate_rays  # noqa: E402
from tests.synthetic import look_at, make_synthetic_dataset, opengl_to_internal  # noqa: E402


def test_generate_rays_center_and_origin():
    # look_at now emits a standard OpenGL pose; generate_rays speaks the internal +z-forward axes, so
    # convert exactly as parse_transforms does (OpenGL→internal) before feeding it (SPEC-13 FR-9).
    c2w = opengl_to_internal(look_at(eye=(0.0, 0.0, 3.0), target=(0.0, 0.0, 0.0)))  # cam at +3z, at origin
    o, d = generate_rays(c2w, fx=20.0, fy=20.0, cx=11.5, cy=11.5, height=24, width=24)
    o, d = np.asarray(o), np.asarray(d)
    assert o.shape == (24 * 24, 3) and d.shape == (24 * 24, 3)
    # the principal-point pixel (cx,cy) ~ index near the centre → its ray points from eye toward origin (−z)
    centre = int((11 * 24) + 11)
    assert np.allclose(o[centre], [0.0, 0.0, 3.0], atol=1e-4)  # origin == camera position
    forward = np.array([0.0, 0.0, -1.0])  # toward the origin from +z
    assert np.dot(d[centre], forward) > 0.99  # the centre ray looks at the target


def test_parse_transforms_recovers_intrinsics_and_poses():
    # `poses` are the internal +z-forward poses; the transforms.json stores their OpenGL form, so this
    # asserts the parser's OpenGL→internal flip round-trips back to them (SPEC-13 FR-9).
    _, poses, intr, transforms = make_synthetic_dataset(n_views=4, h=16, w=16)
    out = parse_transforms(transforms)
    assert out.fx == pytest.approx(intr["fx"]) and out.cx == pytest.approx(intr["cx"])
    assert out.width == 16 and out.height == 16
    assert out.poses.shape == (4, 4, 4)
    assert np.allclose(out.poses, poses, atol=1e-5)


def test_parse_transforms_camera_angle_branch_and_guards():
    import math

    # the FOV (camera_angle_x) path: fx = 0.5 W / tan(0.5 FOVx). Without camera_angle_y, fy = fx.
    fov = 0.6911
    out = parse_transforms({"w": 800, "h": 600, "camera_angle_x": fov, "frames": []})
    assert out.fx == pytest.approx(0.5 * 800 / math.tan(0.5 * fov))
    assert out.fy == pytest.approx(out.fx)  # no camera_angle_y → square-pixel fy = fx

    # the explicit camera_angle_y branch derives fy from the image HEIGHT.
    fovy = 0.5
    out2 = parse_transforms({"w": 800, "h": 600, "camera_angle_x": fov, "camera_angle_y": fovy, "frames": []})
    assert out2.fy == pytest.approx(0.5 * 600 / math.tan(0.5 * fovy))

    with pytest.raises(ValueError, match="positive image width/height"):
        parse_transforms({"camera_angle_x": fov, "frames": []})  # no w/h → degenerate
    with pytest.raises(ValueError, match="fl_x' or 'camera_angle_x"):
        parse_transforms({"w": 800, "h": 600, "frames": []})  # no intrinsics at all


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
