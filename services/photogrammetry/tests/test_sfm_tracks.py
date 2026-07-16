"""P5.1 — feature-track building (union-find) + init-pair selection (`app.sfm`), strict TDD.

Ground truth is the synthetic scene (`tests/synthetic.py`, never modified here). Cross-view feature
correspondences are built directly from the fixture's landmark visibility oracle: a landmark
co-visible in views ``i`` and ``j`` yields a match between its observation-index (feature) in ``i``
and in ``j``. So the pair-match graph is exact and each landmark forms its own connected component.

The tests assert:

* **Track building** reconstructs each landmark's multi-view track (a landmark visible in ``K`` views
  yields a length-``K`` track linking the right features), and the full track set equals the
  ground-truth landmark tracks (sensible total count).
* **Conflict rejection** — a spurious match that would pull two features of the *same* image into one
  component drops that (inconsistent) track; no returned track has two features from one image.
* **Init pair** selects a genuinely wide-baseline pair (views far apart on the fixture arc, large
  triangulation angle), whose robustness score beats a near-adjacent pair's.
* **Determinism** — identical runs return identical results (no RNG; D-10).
"""

from __future__ import annotations

import numpy as np

from app.sfm import build_tracks, init_pair_score, select_init_pair
from tests.synthetic import make_synthetic_scene


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _keypoints_and_pair_matches(scene):
    """Per-image keypoint arrays + ground-truth cross-view pair matches from the fixture.

    A landmark's *feature index* in an image is the row position of its observation among that
    image's visible landmarks; ``keypoints[i][feature]`` is the pixel. A landmark co-visible in views
    ``i`` and ``j`` contributes one match row ``(feat_i, feat_j)``. Pairs are built over all ``i < j``.
    """
    n = scene.poses_w2c.shape[0]
    feat_of = [dict() for _ in range(n)]  # feat_of[i][landmark] = feature index in image i
    obs_uv = [[] for _ in range(n)]  # obs_uv[i] = list of (u, v)
    for m, obs in enumerate(scene.visibility):
        for (view, u, v) in obs:
            feat_of[view][m] = len(obs_uv[view])
            obs_uv[view].append((u, v))
    keypoints = [np.asarray(obs_uv[i], dtype=np.float64).reshape(-1, 2) for i in range(n)]

    pair_matches = []
    for i in range(n):
        for j in range(i + 1, n):
            rows = [(feat_of[i][m], feat_of[j][m]) for m in feat_of[i] if m in feat_of[j]]
            pair_matches.append((i, j, np.asarray(rows, dtype=np.int64).reshape(-1, 2)))
    return keypoints, pair_matches, feat_of


def _gt_tracks(scene, feat_of):
    """Ground-truth landmark tracks ``{image: feature}`` for landmarks visible in >= 2 views."""
    tracks = []
    for m, obs in enumerate(scene.visibility):
        views = [v for (v, _, _) in obs]
        if len(views) >= 2:
            tracks.append({v: feat_of[v][m] for v in views})
    return tracks


def _canon(tracks):
    """Canonical hashable form of a track list for set-equality / determinism checks."""
    return sorted(tuple(sorted(t.items())) for t in tracks)


def _matches_for(pair_matches, i, j):
    for (a, b, m) in pair_matches:
        if (a, b) == (i, j):
            return m
    raise KeyError((i, j))


# --- track building ------------------------------------------------------------------------------

def test_build_tracks_recovers_multiview_landmark_track():
    scene = _scene()
    kp, pair_matches, feat_of = _keypoints_and_pair_matches(scene)
    n = scene.poses_w2c.shape[0]
    tracks = build_tracks(pair_matches, n)

    # A track is a {image_idx: feature_idx} dict spanning >= 2 images, one feature per image.
    assert tracks and all(isinstance(t, dict) and len(t) >= 2 for t in tracks)
    for t in tracks:
        assert len(set(t.keys())) == len(t)

    # The most-observed landmark's exact multi-view track (length K) must be recovered.
    m0 = max(range(scene.points3d.shape[0]), key=lambda m: len(scene.visibility[m]))
    views0 = [v for (v, _, _) in scene.visibility[m0]]
    assert len(views0) >= 3  # a genuine multi-view track, not just a pair
    expected = {v: feat_of[v][m0] for v in views0}
    assert len(expected) == len(views0)
    assert expected in tracks

    # It links the right feature (pixel) in each view.
    for (v, u_exp, w_exp) in scene.visibility[m0]:
        u, w = kp[v][expected[v]]
        assert np.allclose([u, w], [u_exp, w_exp])


def test_build_tracks_count_matches_ground_truth():
    scene = _scene()
    _, pair_matches, feat_of = _keypoints_and_pair_matches(scene)
    n = scene.poses_w2c.shape[0]
    tracks = build_tracks(pair_matches, n)
    # Each landmark forms its own connected component ⇒ the track set is exactly the GT landmark set.
    assert _canon(tracks) == _canon(_gt_tracks(scene, feat_of))


def test_build_tracks_drops_conflicting_merge():
    scene = _scene()
    _, pair_matches, feat_of = _keypoints_and_pair_matches(scene)
    n = scene.poses_w2c.shape[0]
    baseline = build_tracks(pair_matches, n)

    # A pair that co-observes at least two landmarks A, B (both then visible in >= 2 views).
    i, j = 0, 1
    covis = [m for m in feat_of[i] if m in feat_of[j]]
    assert len(covis) >= 2
    A, B = covis[0], covis[1]

    # Inject a spurious cross match A-in-i ↔ B-in-j: this merges A's and B's components, so image j
    # appears twice (feat A_j and feat B_j) in one component — an intra-image conflict.
    bad = []
    for (a, b, m) in pair_matches:
        if (a, b) == (i, j):
            extra = np.array([[feat_of[i][A], feat_of[j][B]]], dtype=np.int64)
            m = np.concatenate([m, extra], axis=0)
        bad.append((a, b, m))
    tracks = build_tracks(bad, n)

    # Invariant holds: no track has two features from one image.
    for t in tracks:
        assert len(set(t.keys())) == len(t)
    # The conflicting component is dropped ⇒ strictly fewer tracks, and A's & B's clean tracks vanish.
    assert len(tracks) < len(baseline)
    gt_a = {v: feat_of[v][A] for (v, _, _) in scene.visibility[A]}
    gt_b = {v: feat_of[v][B] for (v, _, _) in scene.visibility[B]}
    assert gt_a not in tracks
    assert gt_b not in tracks


# --- init-pair selection -------------------------------------------------------------------------

def test_select_init_pair_prefers_wide_baseline():
    scene = _scene()
    kp, pair_matches, _ = _keypoints_and_pair_matches(scene)
    i, j = select_init_pair(pair_matches, kp, scene.K)

    # Adjacent views on the 8-view arc differ by 1; a robust seed must be far apart (large parallax).
    assert abs(i - j) >= 3

    # Its robustness score beats a near-adjacent pair's (tiny baseline ⇒ small triangulation angle).
    wide_score = init_pair_score(_matches_for(pair_matches, i, j), kp[i], kp[j], scene.K)
    adj_score = init_pair_score(_matches_for(pair_matches, 0, 1), kp[0], kp[1], scene.K)
    assert adj_score > 0.0  # the adjacent pair is a valid two-view geometry, just weaker
    assert wide_score > adj_score


# --- determinism ---------------------------------------------------------------------------------

def test_build_tracks_and_init_pair_are_deterministic():
    scene = _scene()
    kp, pair_matches, _ = _keypoints_and_pair_matches(scene)
    n = scene.poses_w2c.shape[0]
    assert _canon(build_tracks(pair_matches, n)) == _canon(build_tracks(pair_matches, n))
    assert select_init_pair(pair_matches, kp, scene.K) == select_init_pair(pair_matches, kp, scene.K)
