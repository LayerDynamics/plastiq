"""P5.2 — the incremental SfM mapper (`app.sfm.reconstruct`), validated end-to-end on the synthetic
scene. The mapper composes tracks → init pair → register/triangulate/bundle-adjust into a full sparse
reconstruction; correctness is measured against the fixture's exact ground-truth poses (aligned by the
best similarity, since SfM recovers geometry only up to a similarity)."""

from __future__ import annotations

import numpy as np

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


def test_filter_high_reproj_points_removes_contaminated_structure():
    """Regression (real-photo mapper hardening): the reprojection-outlier filter deletes points that
    reproject far from their observed keypoints — the track-merge-contaminated structure that pulled
    real-photo bundle adjustment's mean reprojection error to ~5px — while keeping accurate points.
    Without it the mapper's absolute-inlier registration would silently corrupt the cloud."""
    from app.sfm import _filter_high_reproj_points, _proj

    K = np.array([[500.0, 0.0, 320.0], [0.0, 500.0, 240.0], [0.0, 0.0, 1.0]])
    poses = {
        0: np.hstack([np.eye(3), np.zeros((3, 1))]),
        1: np.hstack([np.eye(3), np.array([[-0.6], [0.0], [0.0]])]),  # sideways baseline
    }
    coords = {0: [0.0, 0.0, 5.0], 1: [0.3, 0.1, 6.0], 2: [-0.2, 0.2, 4.0],
              3: [0.1, -0.3, 7.0], 4: [-0.1, -0.1, 5.5], 5: [0.2, 0.2, 5.0]}
    points3d = {t: np.asarray(x, dtype=float) for t, x in coords.items()}

    kp0, kp1, tracks = [], [], []
    for t in range(6):
        Xh = np.append(points3d[t], 1.0)
        p0 = _proj(K, poses[0]) @ Xh
        p1 = _proj(K, poses[1]) @ Xh
        uv0, uv1 = p0[:2] / p0[2], p1[:2] / p1[2]
        if t == 5:  # contaminate point 5: its observed keypoints are 30px off the true projection
            uv0 = uv0 + np.array([30.0, 0.0])
            uv1 = uv1 + np.array([0.0, 30.0])
        kp0.append(uv0)
        kp1.append(uv1)
        tracks.append({0: t, 1: t})
    keypoints = [np.asarray(kp0), np.asarray(kp1)]

    removed = _filter_high_reproj_points(poses, points3d, tracks, keypoints, K, max_px=4.0)
    assert removed == 1
    assert 5 not in points3d
    assert set(points3d) == {0, 1, 2, 3, 4}  # the five accurate points survive


def test_verify_pair_matches_rejects_geometric_outliers():
    """Regression (real-photo track cleaning): geometric verification keeps epipolar-consistent matches
    and drops the outliers that, propagated through union-find tracks, collapsed PnP inlier ratios and
    stalled the mapper on real photos."""
    from app.sfm import verify_pair_matches

    rng = np.random.default_rng(7)
    K = np.array([[600.0, 0.0, 320.0], [0.0, 600.0, 240.0], [0.0, 0.0, 1.0]])
    pose0 = np.hstack([np.eye(3), np.zeros((3, 1))])
    pose1 = np.hstack([np.eye(3), np.array([[-0.7], [0.02], [0.0]])])  # sideways baseline

    def project(pose, X):
        p = K @ (pose[:, :3] @ X + pose[:, 3])
        return p[:2] / p[2]

    n_true = 60
    pts3d = np.column_stack([rng.uniform(-1, 1, n_true), rng.uniform(-1, 1, n_true), rng.uniform(4, 8, n_true)])
    kp0 = np.array([project(pose0, X) for X in pts3d])
    kp1_true = np.array([project(pose1, X) for X in pts3d])
    # 40 outlier keypoints in view 1 (random pixels), matched to real view-0 features → epipolar-wrong.
    kp1_outliers = np.column_stack([rng.uniform(0, 640, 40), rng.uniform(0, 480, 40)])
    kp1 = np.vstack([kp1_true, kp1_outliers])

    true_matches = [(i, i) for i in range(n_true)]
    outlier_matches = [(int(rng.integers(n_true)), n_true + k) for k in range(40)]
    matches = np.array(true_matches + outlier_matches, dtype=np.int64)

    verified = verify_pair_matches([(0, 1, matches)], [kp0, kp1], seed=0, threshold=2.0, min_inliers=8)
    assert len(verified) == 1
    kept = verified[0][2].shape[0]
    # The ~60 epipolar-consistent matches survive; the 40 random outliers are rejected.
    assert 50 <= kept <= n_true + 3, f"kept {kept} of {n_true} true + 40 outliers"
