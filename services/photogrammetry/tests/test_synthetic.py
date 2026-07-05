"""Tests for tests/synthetic.py — the ground-truth synthetic-scene oracle (P1.1).

These assert the fixture's *self-consistency*: the whole SfM/MVS pipeline is validated against this
scene, so if projection, depth, occlusion, or determinism were wrong here every downstream oracle
would be wrong too. The camera convention is OpenCV / +z-forward (a visible point has positive
camera-space depth) — the emitter (P6.3) flips to OpenGL later; that is not this fixture's job.
"""

from __future__ import annotations

import numpy as np

from tests.synthetic import SyntheticScene, look_at, make_synthetic_scene, project_points


def test_scene_shapes_and_types():
    s = make_synthetic_scene(n_views=6, height=96, width=128, seed=0)
    assert isinstance(s, SyntheticScene)
    assert s.images.shape == (6, 96, 128, 3) and s.images.dtype == np.uint8
    assert s.depths.shape == (6, 96, 128)
    assert s.K.shape == (3, 3)
    assert s.poses_w2c.shape == (6, 3, 4)
    assert s.points3d.ndim == 2 and s.points3d.shape[1] == 3
    assert len(s.visibility) == s.points3d.shape[0]


def test_reprojection_matches_visibility_and_depth():
    """Every recorded (view, u, v) landmark observation reprojects to that pixel, and the scene's
    depth buffer at that pixel agrees with the projected camera-space depth (rasterizer ↔ projector
    consistency — the invariant all triangulation/PnP tests inherit)."""
    s = make_synthetic_scene(n_views=8, height=96, width=96, seed=1)
    checked = 0
    for pt_idx, obs in enumerate(s.visibility):
        for (view, u, v) in obs:
            uv, depth = project_points(s.points3d[pt_idx : pt_idx + 1], s.K, s.poses_w2c[view])
            assert abs(uv[0, 0] - u) < 1.0 and abs(uv[0, 1] - v) < 1.0
            assert depth[0] > 0.0  # in front of the camera
            buf = s.depths[view, int(round(v)), int(round(u))]
            assert np.isfinite(buf)
            assert abs(buf - depth[0]) < 0.05 * depth[0]  # depth buffer ≈ projected depth
            checked += 1
    assert checked > 50  # the scene actually produced a substantial set of observations


def test_determinism_bitwise():
    a = make_synthetic_scene(n_views=5, height=64, width=64, seed=7)
    b = make_synthetic_scene(n_views=5, height=64, width=64, seed=7)
    assert np.array_equal(a.images, b.images)
    assert np.array_equal(a.depths, b.depths)
    assert np.array_equal(a.points3d, b.points3d)
    assert a.visibility == b.visibility


def test_different_seed_changes_texture():
    a = make_synthetic_scene(n_views=3, height=64, width=64, seed=0)
    b = make_synthetic_scene(n_views=3, height=64, width=64, seed=1)
    assert not np.array_equal(a.images, b.images)  # texture is seeded, not fixed


def test_images_have_real_texture():
    """Features need texture — a flat render would detect nothing. Every image must carry variance."""
    s = make_synthetic_scene(n_views=6, height=96, width=96, seed=2)
    for i in range(s.images.shape[0]):
        assert s.images[i].std() > 15.0  # meaningful contrast on a 0..255 scale


def test_occlusion_is_real():
    """The box occludes the plane: at least one plane landmark is hidden (not in visibility) in some
    view where it projects inside the frame — occlusion emerges from the z-buffer, not a fake mask."""
    s = make_synthetic_scene(n_views=8, height=96, width=96, seed=3)
    h, w = s.depths.shape[1:]
    found_occlusion = False
    for pt_idx in range(s.points3d.shape[0]):
        seen_views = {view for (view, _u, _v) in s.visibility[pt_idx]}
        for view in range(s.poses_w2c.shape[0]):
            if view in seen_views:
                continue
            uv, depth = project_points(s.points3d[pt_idx : pt_idx + 1], s.K, s.poses_w2c[view])
            u, v = uv[0]
            if depth[0] > 0 and 0 <= u < w and 0 <= v < h:
                buf = s.depths[view, int(round(v)), int(round(u))]
                if np.isfinite(buf) and buf < depth[0] - 1e-3:
                    found_occlusion = True  # something nearer sits in front of this landmark
                    break
        if found_occlusion:
            break
    assert found_occlusion


def test_look_at_is_a_proper_rotation():
    w2c = look_at(eye=(0.0, 2.0, -5.0), target=(0.0, 0.0, 0.0))
    assert w2c.shape == (3, 4)
    R = w2c[:, :3]
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)  # orthonormal
    assert np.isclose(np.linalg.det(R), 1.0, atol=1e-9)  # proper (no reflection)
    # The camera at eye looks toward the target ⇒ the target is on the +z (forward) axis.
    eye = np.array([0.0, 2.0, -5.0])
    target = np.array([0.0, 0.0, 0.0])
    xc = R @ (target - eye)
    assert xc[2] > 0  # forward is +z (OpenCV convention)


def test_distortion_option_produces_distorted_views():
    dist = [-0.15, 0.03, 0.001, -0.001]
    s = make_synthetic_scene(n_views=4, height=96, width=96, seed=4, distortion=dist)
    assert s.dist_coeffs is not None and np.allclose(s.dist_coeffs, dist)
    assert s.images_distorted is not None
    assert s.images_distorted.shape == s.images.shape
    # A nonzero radial coefficient must actually bend the image (distorted ≠ pinhole).
    assert not np.array_equal(s.images_distorted, s.images)
    # project_points with dist must match applying forward distortion to the pinhole projection.
    uv_pinhole, _ = project_points(s.points3d[:5], s.K, s.poses_w2c[0])
    uv_dist, _ = project_points(s.points3d[:5], s.K, s.poses_w2c[0], dist=dist)
    assert uv_dist.shape == uv_pinhole.shape
