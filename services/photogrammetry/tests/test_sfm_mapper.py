"""P5.2 — the incremental SfM mapper (`app.sfm.reconstruct`), validated end-to-end on the synthetic
scene. The mapper composes tracks → init pair → register/triangulate/bundle-adjust into a full sparse
reconstruction; correctness is measured against the fixture's exact ground-truth poses (aligned by the
best similarity, since SfM recovers geometry only up to a similarity)."""

from __future__ import annotations

import numpy as np
import pytest

from app.sfm import build_tracks, reconstruct, select_init_pair
from tests.synthetic import make_synthetic_scene
from tests.umeyama import aligned_rmse


def _build_problem(scene, break_view: int | None = None, seed: int = 0):
    """From the fixture build (tracks, keypoints, pair_matches, image_names). If ``break_view`` is
    given, that view's keypoints are replaced with random pixels so it cannot register."""
    n = scene.poses_w2c.shape[0]
    keypoints: list = [[] for _ in range(n)]
    feat_of: list = [dict() for _ in range(n)]  # feat_of[view][landmark] -> feature index
    for m in range(scene.points3d.shape[0]):
        for (v, u, w) in scene.visibility[m]:
            feat_of[v][m] = len(keypoints[v])
            keypoints[v].append((u, w))
    keypoints = [np.array(k, dtype=np.float64) if k else np.zeros((0, 2)) for k in keypoints]

    if break_view is not None:
        rng = np.random.default_rng(seed)
        h, w = scene.depths.shape[1:]
        keypoints[break_view] = rng.uniform([0, 0], [w, h], size=keypoints[break_view].shape)

    pair_matches = []
    for i in range(n):
        for j in range(i + 1, n):
            rows = [(feat_of[i][m], feat_of[j][m]) for m in feat_of[i] if m in feat_of[j]]
            if rows:
                pair_matches.append((i, j, np.array(rows, dtype=np.int64)))
    tracks = build_tracks(pair_matches, n)
    names = [f"view_{v}.jpg" for v in range(n)]
    return tracks, keypoints, pair_matches, names


def _gt_centers(scene):
    return np.array([-p[:, :3].T @ p[:, 3] for p in scene.poses_w2c])


def _scene_diameter(scene):
    c = _gt_centers(scene)
    return float(np.max(np.linalg.norm(c[:, None] - c[None], axis=2)))


def test_reconstruct_registers_all_views():
    scene = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    tracks, keypoints, pair_matches, names = _build_problem(scene)
    init = select_init_pair(pair_matches, keypoints, scene.K)
    result = reconstruct(tracks, keypoints, scene.K, init_pair=init, image_names=names)
    assert len(result.registered) == 8, f"only {len(result.registered)}/8 registered"
    assert result.mean_reproj < 1.0  # sub-pixel on exact synthetic data


def test_reconstruct_poses_match_ground_truth_up_to_similarity():
    scene = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    tracks, keypoints, pair_matches, names = _build_problem(scene)
    init = select_init_pair(pair_matches, keypoints, scene.K)
    result = reconstruct(tracks, keypoints, scene.K, init_pair=init, image_names=names)

    reg = sorted(result.registered)
    rec_centers = np.array([-result.poses_w2c[v][:, :3].T @ result.poses_w2c[v][:, 3] for v in reg])
    gt_centers = _gt_centers(scene)[reg]
    rmse = aligned_rmse(rec_centers, gt_centers)
    assert rmse < 0.01 * _scene_diameter(scene), f"aligned camera-centre RMSE {rmse:.4f}"


def test_reconstruct_triangulates_most_structure():
    scene = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    tracks, keypoints, pair_matches, names = _build_problem(scene)
    init = select_init_pair(pair_matches, keypoints, scene.K)
    result = reconstruct(tracks, keypoints, scene.K, init_pair=init, image_names=names)
    # ≥ 80% of the multi-view tracks got a 3D point.
    multiview = sum(1 for t in tracks if len(t) >= 3)
    assert len(result.points3d) >= 0.8 * multiview


def test_broken_view_is_reported_unregistered():
    scene = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)
    tracks, keypoints, pair_matches, names = _build_problem(scene, break_view=4)
    # Init pair must avoid the broken view; pick the widest clean pair.
    init = (0, 7)
    result = reconstruct(tracks, keypoints, scene.K, init_pair=init, image_names=names)
    assert "view_4.jpg" in result.unregistered_names
    assert len(result.registered) >= 6  # the rest still reconstruct


def test_reconstruct_is_deterministic():
    scene = make_synthetic_scene(n_views=6, height=96, width=96, seed=0)
    tracks, keypoints, pair_matches, names = _build_problem(scene)
    init = select_init_pair(pair_matches, keypoints, scene.K)
    a = reconstruct(tracks, keypoints, scene.K, init_pair=init, image_names=names, seed=1)
    b = reconstruct(tracks, keypoints, scene.K, init_pair=init, image_names=names, seed=1)
    assert sorted(a.registered) == sorted(b.registered)
    for v in a.registered:
        assert np.allclose(a.poses_w2c[v], b.poses_w2c[v])
