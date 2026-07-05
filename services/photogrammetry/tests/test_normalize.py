"""Tests for the scene-normalization similarity (SPEC-13 §5.4-5, D-5, FR-8; plan P6.1).

The producer must pre-normalize the solved scene because the nerf consumer has a *fixed* scene
radius (``services/nerf/app/engine/pipeline.py:28`` ``_SCENE_RADIUS = 1.5``): un-normalized scenes
clip. ``app.normalize`` applies a world→world similarity so that the sparse-point median maps to the
origin, the 90th-percentile point radius maps to 1.0, and the mean camera-up maps to +z, recording
the forward similarity as ``applied_transform`` (solver world → normalized world) + ``scale``.

Ground truth is the committed synthetic fixture (``tests/synthetic.py``): OpenCV +z-forward w2c
poses ``[R | t]`` and reprojection-consistent landmarks, so the reprojection-invariance test is an
exact oracle, not a smoke check.

``normalize.py`` sits on the CI import seam (NFR-4) alongside ``emit``/``exif``/``jobs`` and must
import without MLX — asserted here in a fresh subprocess so the check targets *this module's own*
import chain, not whatever the shared pytest process happens to have loaded.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import numpy as np

from app.normalize import NormalizeResult, normalize_scene
from tests.synthetic import make_synthetic_scene, project_points

_SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _mean_camera_up(poses_w2c: np.ndarray) -> np.ndarray:
    """Unit mean camera-up in world (OpenCV camera up = -R[1], the nerfstudio 'up' analog)."""
    ups = np.stack([-np.asarray(p, dtype=np.float64)[1, :3] for p in poses_w2c])
    mean_up = ups.mean(axis=0)
    return mean_up / np.linalg.norm(mean_up)


def test_returns_normalizeresult_with_shapes():
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    assert isinstance(r, NormalizeResult)
    assert r.poses_w2c.shape == s.poses_w2c.shape  # (N, 3, 4)
    assert r.points3d.shape == s.points3d.shape  # (M, 3)
    assert np.asarray(r.applied_transform).shape == (3, 4)
    assert np.isscalar(r.scale) or np.ndim(r.scale) == 0


def test_sparse_point_median_at_origin():
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    median = np.median(r.points3d, axis=0)
    assert np.allclose(median, 0.0, atol=1e-9)


def test_p90_radius_is_one():
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    radii = np.linalg.norm(r.points3d, axis=1)  # about the new (origin) center
    assert abs(float(np.percentile(radii, 90)) - 1.0) < 1e-9


def test_mean_camera_up_maps_to_plus_z():
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    # Recompute up from the *transformed* poses: a genuine pose-consistency check, not a tautology.
    mean_up = _mean_camera_up(r.poses_w2c)
    assert float(mean_up @ np.array([0.0, 0.0, 1.0])) > 0.99


def test_reprojection_invariance():
    """Projecting a transformed point through the transformed pose yields the SAME pixel."""
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    max_diff = 0.0
    for view in range(s.poses_w2c.shape[0]):
        uv_orig, _ = project_points(s.points3d, s.K, s.poses_w2c[view])
        uv_norm, _ = project_points(r.points3d, s.K, r.poses_w2c[view])
        max_diff = max(max_diff, float(np.abs(uv_orig - uv_norm).max()))
    assert max_diff < 1e-6


def test_applied_transform_is_forward_solver_to_normalized():
    """applied_transform maps ORIGINAL world → normalized world: X' = A[:, :3] @ X + A[:, 3]."""
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    A = np.asarray(r.applied_transform, dtype=np.float64)
    predicted = s.points3d @ A[:, :3].T + A[:, 3]
    assert np.allclose(predicted, r.points3d, atol=1e-9)


def test_inverse_recovers_solver_frame():
    """Applying the inverse of applied_transform to normalized points returns the originals."""
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    A = np.asarray(r.applied_transform, dtype=np.float64)
    T = np.eye(4)
    T[:3, :] = A
    Tinv = np.linalg.inv(T)
    homog = np.concatenate([r.points3d, np.ones((r.points3d.shape[0], 1))], axis=1)
    recovered = (homog @ Tinv.T)[:, :3]
    assert np.allclose(recovered, s.points3d, atol=1e-9)


def test_scale_field_matches_applied_transform():
    s = _scene()
    r = normalize_scene(s.poses_w2c, s.points3d)
    A = np.asarray(r.applied_transform, dtype=np.float64)
    # applied_transform's linear block is s * R_n with R_n a rotation, so ||row|| == scale.
    row_norms = np.linalg.norm(A[:, :3], axis=1)
    assert np.allclose(row_norms, float(r.scale), rtol=1e-9)
    assert float(r.scale) > 0.0


def test_deterministic():
    s = _scene()
    r1 = normalize_scene(s.poses_w2c, s.points3d)
    r2 = normalize_scene(s.poses_w2c, s.points3d)
    assert np.array_equal(r1.points3d, r2.points3d)
    assert np.array_equal(r1.poses_w2c, r2.poses_w2c)
    assert np.array_equal(np.asarray(r1.applied_transform), np.asarray(r2.applied_transform))


def test_does_not_mutate_inputs():
    s = _scene()
    poses_before = s.poses_w2c.copy()
    points_before = s.points3d.copy()
    normalize_scene(s.poses_w2c, s.points3d)
    assert np.array_equal(s.poses_w2c, poses_before)
    assert np.array_equal(s.points3d, points_before)


def test_import_is_mlx_free():
    """`app.normalize`'s own import chain must not load mlx (NFR-4 CI seam).

    Run in a fresh subprocess so the assertion targets this module's imports, not mlx that another
    test (features/match/mvs) may have already loaded into the shared pytest process.
    """
    code = (
        "import sys, app.normalize; "
        "bad = [m for m in sys.modules if m == 'mlx' or m.startswith('mlx.')]; "
        "assert not bad, bad"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(_SERVICE_ROOT),
        env={**os.environ, "PYTHONPATH": "."},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
