"""Structure-from-Motion mapper front-end: feature tracks + initial-pair selection (P5.1).

This module composes the verified two-view primitives (``app.core.epipolar``,
``app.core.triangulate``) into the first two stages of the incremental mapper (SPEC-13 §5.1, §5.4-3);
the register→triangulate→bundle-adjust loop is appended here by P5.2 (this file is shared).

1. :func:`build_tracks` — a **union-find** over per-image feature indices links every pairwise match
   into connected components. A *track* is one component, represented as ``{image_idx: feature_idx}``
   — at most one feature per image. Components that would place two different features of the *same*
   image into one track are inconsistent (an incorrect match bridged two real landmarks) and are
   dropped, so every returned track is a clean one-feature-per-image correspondence spanning ≥ 2
   images. This is the structure the incremental mapper (P5.2) triangulates and grows.

2. :func:`select_init_pair` — the reconstruction seed. Following COLMAP/Schönberger 2016 (SPEC-13
   §5.4-3), the best initial pair maximises a robustness score = *(geometrically-verified two-view
   inliers)* × *(median triangulation angle of those inliers)*. A wide-baseline pair with a large
   parallax angle triangulates a well-conditioned seed cloud; a near-adjacent pair (tiny baseline,
   near-homography) triangulates an ill-conditioned one and scores low even when its raw inlier count
   is high. The two-view geometry is recovered from the correspondences themselves (normalized
   8-point fundamental → essential → cheirality-selected pose), never from ground truth.

**Track data structure (the P5.2 contract):** ``list[dict[int, int]]`` — each dict maps an image
index to that image's feature (keypoint) index; the keypoint's pixel is ``keypoints[image][feature]``.
The list is in a canonical (sorted) order so it is reproducible.

Numerics (docs/adr/0013 D-9): float64 numpy/CPU via the reused solver tier; union-find is exact
integer bookkeeping. No RNG (D-10) — deterministic given the input pair-match order. No ``cv2``/MLX
import (D-1 / NFR-4).

Attribution: the incremental-mapper shape follows Schönberger & Frahm, *Structure-from-Motion
Revisited*, CVPR 2016; the init-pair inliers×angle heuristic is the classical COLMAP criterion. No
code copied.
"""

from __future__ import annotations

import numpy as np

from app.core.epipolar import find_fundamental, recover_pose
from app.core.triangulate import triangulate

__all__ = [
    "build_tracks",
    "init_pair_score",
    "select_init_pair",
]

_MIN_FUNDAMENTAL = 8  # the normalized 8-point algorithm needs >= 8 correspondences


# ---------------------------------------------------------------------------------------------
# Track building (union-find over per-image feature indices)
# ---------------------------------------------------------------------------------------------

def build_tracks(pair_matches, n_images: int) -> list[dict]:
    """Link pairwise feature matches into multi-view tracks via union-find.

    Args:
        pair_matches: ``[(i, j, matches)]`` — for image pair ``(i, j)`` an ``(P, 2)`` int array whose
            row ``(fi, fj)`` links feature ``fi`` in image ``i`` to feature ``fj`` in image ``j``.
        n_images: total number of images (kept for the caller's contract / the P5.2 mapper; the union
            over the matched nodes alone determines correctness).

    Returns:
        A list of tracks, each a ``{image_idx: feature_idx}`` dict spanning ≥ 2 images with at most
        one feature per image. Components with an intra-image conflict (two features of one image
        pulled together by an inconsistent match) are dropped. Output order is canonical (sorted by
        each track's ``(image, feature)`` items) so runs are deterministic.
    """
    parent: dict = {}

    def find(x):
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:  # path compression
            parent[x], x = root, parent[x]
        return root

    def add(x):
        if x not in parent:
            parent[x] = x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        # Deterministic root: the lexicographically smaller (image, feature) node wins.
        if rb < ra:
            ra, rb = rb, ra
        parent[rb] = ra

    for (i, j, matches) in pair_matches:
        m = np.asarray(matches)
        if m.size == 0:
            continue
        m = m.reshape(-1, 2)
        for row in m:
            a = (int(i), int(row[0]))
            b = (int(j), int(row[1]))
            add(a)
            add(b)
            union(a, b)

    components: dict = {}
    for node in parent:
        components.setdefault(find(node), []).append(node)

    tracks: list[dict] = []
    for members in components.values():
        track: dict = {}
        conflict = False
        for (img, feat) in members:
            if img in track and track[img] != feat:
                conflict = True  # two different features of one image ⇒ inconsistent track
                break
            track[img] = feat
        if conflict or len(track) < 2:
            continue
        tracks.append(track)

    tracks.sort(key=lambda t: tuple(sorted(t.items())))
    return tracks


# ---------------------------------------------------------------------------------------------
# Initial-pair selection (inliers × median triangulation angle)
# ---------------------------------------------------------------------------------------------

def _triangulation_angles_deg(R, t, q1, q2) -> np.ndarray:
    """Per-point triangulation (parallax) angle in degrees for normalized correspondences.

    Camera 1 sits at the origin (``P1 = [I | 0]``), camera 2 at ``P2 = [R | t]`` with ``t`` a unit
    direction; the angle between the rays ``C1→X`` and ``C2→X`` is scale-invariant, so the unit
    baseline yields the true parallax angle at each triangulated point.
    """
    P1 = np.hstack([np.eye(3), np.zeros((3, 1))])
    P2 = np.hstack([R, t.reshape(3, 1)])
    X = triangulate(P1, P2, q1, q2)  # (N, 3) in the camera-1 frame
    C1 = np.zeros(3)
    C2 = -R.T @ t
    r1 = X - C1
    r2 = X - C2
    r1 /= np.linalg.norm(r1, axis=1, keepdims=True) + 1e-15
    r2 /= np.linalg.norm(r2, axis=1, keepdims=True) + 1e-15
    cos = np.clip(np.sum(r1 * r2, axis=1), -1.0, 1.0)
    return np.degrees(np.arccos(cos))


def init_pair_score(matches, kp_i, kp_j, K) -> float:
    """Robustness score for one candidate initial pair: inliers × median triangulation angle.

    The two-view geometry is estimated from the correspondences alone — normalized 8-point
    fundamental → essential ``E = Kᵀ F K`` (shared intrinsics) → cheirality-selected relative pose —
    and the inliers are the cheirality-valid correspondences (in front of both cameras). The score is
    ``len(inliers) × median(triangulation angle of the inliers)`` in degrees: a wide baseline gives a
    large angle (well-conditioned seed), a near-homography pair a tiny one. Returns ``0.0`` for pairs
    with too few matches or a degenerate recovery.

    Args:
        matches: ``(P, 2)`` int match rows ``(fi, fj)`` indexing ``kp_i`` / ``kp_j``.
        kp_i, kp_j: ``(K_i, 2)`` / ``(K_j, 2)`` pixel keypoint arrays for the two images.
        K: shared ``(3, 3)`` camera intrinsics.
    """
    m = np.asarray(matches).reshape(-1, 2)
    if m.shape[0] < _MIN_FUNDAMENTAL:
        return 0.0
    kp_i = np.asarray(kp_i, dtype=np.float64)
    kp_j = np.asarray(kp_j, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    pts1 = kp_i[m[:, 0]]
    pts2 = kp_j[m[:, 1]]

    F = find_fundamental(pts1, pts2)
    E = K.T @ F @ K  # x2ᵀ F x1 = q2ᵀ (Kᵀ F K) q1 = q2ᵀ E q1 (shared K)
    R, t, mask = recover_pose(E, pts1, pts2, K, K)
    n_in = int(mask.sum())
    if n_in < 2:
        return 0.0

    ones = np.ones((n_in, 1))
    q1 = np.linalg.solve(K, np.hstack([pts1[mask], ones]).T).T[:, :2]  # normalized inliers
    q2 = np.linalg.solve(K, np.hstack([pts2[mask], ones]).T).T[:, :2]
    median_angle = float(np.median(_triangulation_angles_deg(R, t, q1, q2)))
    return n_in * median_angle


def select_init_pair(pair_matches, keypoints, K) -> tuple[int, int]:
    """Choose the initial image pair maximising the :func:`init_pair_score` robustness score.

    Args:
        pair_matches: ``[(i, j, matches)]`` as for :func:`build_tracks`.
        keypoints: per-image ``(K_i, 2)`` pixel arrays (``keypoints[i]`` indexes image ``i``'s
            features).
        K: shared ``(3, 3)`` intrinsics.

    Returns:
        ``(i, j)`` of the best pair. Ties break toward the higher raw match count, then the earliest
        pair encountered — deterministic (D-10).

    Raises:
        ValueError: if ``pair_matches`` is empty.
    """
    best_key = None
    best_pair = None
    for (i, j, matches) in pair_matches:
        m = np.asarray(matches).reshape(-1, 2)
        score = init_pair_score(m, keypoints[i], keypoints[j], K)
        key = (score, m.shape[0])
        if best_key is None or key > best_key:  # strict > ⇒ first max-key pair wins (deterministic)
            best_key = key
            best_pair = (int(i), int(j))
    if best_pair is None:
        raise ValueError("pair_matches is empty; cannot select an initial pair")
    return best_pair
