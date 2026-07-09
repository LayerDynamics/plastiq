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


# ---------------------------------------------------------------------------------------------
# Incremental mapper (P5.2): init → register → triangulate → bundle-adjust
# ---------------------------------------------------------------------------------------------

from dataclasses import dataclass  # noqa: E402  (kept next to the mapper it serves)

from app.core.ba import (  # noqa: E402
    inverse_rodrigues,
    pack,
    rodrigues,
    run_bundle_adjustment,
    unpack,
)
from app.core.ransac import ransac_essential, ransac_pnp  # noqa: E402
from app.core.triangulate import triangulate_gated  # noqa: E402

__all__ += ["SfmResult", "reconstruct"]

_GLOBAL_BA_EVERY = 5  # run a full global bundle adjustment every N registrations


@dataclass
class SfmResult:
    """Output of :func:`reconstruct`.

    Attributes:
        poses_w2c: ``{image_idx: (3, 4)}`` world→camera ``[R | t]`` for each registered view, in the
            reconstruction's own frame (camera of the init pair's first image = identity; recovered
            up to a global similarity).
        points3d: ``{track_id: (3,)}`` triangulated world points (``track_id`` indexes the input
            ``tracks`` list).
        registered: registered image indices, in registration order.
        unregistered_names: names of images that appear in tracks but could not be registered.
        mean_reproj: mean reprojection error (px) over all surviving observations.
    """

    poses_w2c: dict
    points3d: dict
    registered: list
    unregistered_names: list
    mean_reproj: float


def _proj(K, pose):
    return K @ pose  # (3, 4) = K [R | t]


def _run_ba(poses, points3d, tracks, keypoints, K, *, fix_intrinsics, free_cams=None):
    """Bundle-adjust the current reconstruction in place (poses + points updated)."""
    reg = sorted(poses)
    tids = sorted(points3d)
    if len(reg) < 2 or len(tids) < 1:
        return
    cam_index = {v: i for i, v in enumerate(reg)}
    pt_index = {tid: i for i, tid in enumerate(tids)}
    intr = np.array([K[0, 0], K[0, 2], K[1, 2], 0.0, 0.0, 0.0, 0.0])
    cam_params = np.zeros((len(reg), 6))
    for v, i in cam_index.items():
        cam_params[i, :3] = inverse_rodrigues(poses[v][:, :3])
        cam_params[i, 3:] = poses[v][:, 3]
    pts = np.array([points3d[tid] for tid in tids])
    obs = []
    for tid in tids:
        for v, feat in tracks[tid].items():
            if v in cam_index:
                u, w = keypoints[v][feat]
                obs.append((cam_index[v], pt_index[tid], u, w))
    obs = np.array(obs, dtype=np.float64)
    if obs.shape[0] < len(reg) + len(tids):
        return
    x0 = pack(intr, cam_params, pts)
    free = None if free_cams is None else [cam_index[v] for v in free_cams if v in cam_index]
    x_opt, _ = run_bundle_adjustment(
        x0, obs, len(reg), len(tids), fix_intrinsics=fix_intrinsics, free_cams=free
    )
    _, cam2, pts2 = unpack(x_opt, len(reg), len(tids))
    for v, i in cam_index.items():
        poses[v] = np.hstack([rodrigues(cam2[i, :3]), cam2[i, 3:].reshape(3, 1)])
    for tid in tids:
        points3d[tid] = pts2[pt_index[tid]]


def _mean_reproj(poses, points3d, tracks, keypoints, K):
    errs = []
    for tid, X in points3d.items():
        Xh = np.append(X, 1.0)
        for v, feat in tracks[tid].items():
            if v in poses:
                p = _proj(K, poses[v]) @ Xh
                if p[2] > 1e-9:
                    errs.append(np.linalg.norm(p[:2] / p[2] - keypoints[v][feat]))
    return float(np.mean(errs)) if errs else float("inf")


def reconstruct(tracks, keypoints, K, *, init_pair, image_names=None, seed=0,
                fix_intrinsics=True, min_pnp=6, reproj_gate=4.0, parallax_gate_deg=1.5):
    """Incrementally reconstruct camera poses + a sparse point cloud from feature tracks.

    Seeds from ``init_pair`` (two-view essential + cheirality), then repeatedly registers the
    unregistered view seeing the most triangulated tracks (DLT-PnP RANSAC), triangulates its new
    tracks (cheirality/reprojection/parallax gated), runs local bundle adjustment, and a periodic +
    final global bundle adjustment (SPEC-13 §5.4-3/4). Intrinsics are held fixed by default (the
    synthetic/known-K case); the P7 real-photo path frees them for self-calibration.

    Args:
        tracks: ``list[{image_idx: feature_idx}]`` from :func:`build_tracks`.
        keypoints: per-image ``(K_i, 2)`` pixel arrays.
        K: shared ``(3, 3)`` intrinsics.
        init_pair: ``(i, j)`` seed pair (e.g. from :func:`select_init_pair`).
        image_names: optional per-image names for ``unregistered_names`` reporting.
        seed: RANSAC seed threaded into PnP (D-10).
        fix_intrinsics: hold intrinsics fixed in BA (default; set False for self-calibration).

    Returns:
        An :class:`SfmResult`.
    """
    K = np.asarray(K, dtype=np.float64)
    i0, j0 = int(init_pair[0]), int(init_pair[1])
    all_images = sorted({img for t in tracks for img in t})
    names = image_names if image_names is not None else [str(v) for v in range(max(all_images) + 1)]

    # --- seed from the init pair -------------------------------------------------------------
    both = [(tid, t) for tid, t in enumerate(tracks) if i0 in t and j0 in t]
    pts_i = np.array([keypoints[i0][t[i0]] for _, t in both], dtype=np.float64)
    pts_j = np.array([keypoints[j0][t[j0]] for _, t in both], dtype=np.float64)
    # Robust two-view init: RANSAC the essential matrix (real matches carry outliers, so the raw
    # 5-point minimal solver on all correspondences is unusable — this mirrors the PnP registration).
    _, R, t, _ = ransac_essential(pts_i, pts_j, K, K, seed=seed, threshold=reproj_gate)

    poses: dict = {i0: np.hstack([np.eye(3), np.zeros((3, 1))]), j0: np.hstack([R, t.reshape(3, 1)])}
    points3d: dict = {}
    reg_order = [i0, j0]

    P_i = _proj(K, poses[i0])
    P_j = _proj(K, poses[j0])
    tids0 = [tid for tid, _ in both]
    X0, valid0 = triangulate_gated(P_i, P_j, pts_i, pts_j, max_px=reproj_gate, min_deg=parallax_gate_deg)
    for k, tid in enumerate(tids0):
        if valid0[k]:
            points3d[tid] = X0[k]

    _run_ba(poses, points3d, tracks, keypoints, K, fix_intrinsics=fix_intrinsics)

    # --- incremental registration ------------------------------------------------------------
    # A view that fails PnP is not abandoned: it is retried once its triangulated-track *evidence*
    # grows (more structure registered since), the standard incremental-SfM recovery. ``last_attempt``
    # records the track count at each failure so a view is only re-attempted with strictly more
    # evidence — bounded, so a genuinely unregisterable view (e.g. a mismatched image) can't loop.
    last_attempt: dict = {}
    since_global = 0
    while True:
        best_v, best_count = None, 0
        for v in all_images:
            if v in poses:
                continue
            count = sum(1 for tid in points3d if v in tracks[tid])
            if count < min_pnp or count <= last_attempt.get(v, -1):
                continue  # too little structure, or no new evidence since this view last failed
            if count > best_count:
                best_v, best_count = v, count
        if best_v is None:
            break

        tids_v = [tid for tid in points3d if best_v in tracks[tid]]
        X = np.array([points3d[tid] for tid in tids_v], dtype=np.float64)
        uv = np.array([keypoints[best_v][tracks[tid][best_v]] for tid in tids_v], dtype=np.float64)
        try:
            Rv, tv, mask = ransac_pnp(X, uv, K, seed=seed, threshold=reproj_gate)
        except (ValueError, np.linalg.LinAlgError):
            last_attempt[best_v] = best_count
            continue
        n_in = int(mask.sum())
        if n_in < min_pnp or n_in < 0.3 * len(tids_v):  # bad registration ⇒ retry when evidence grows
            last_attempt[best_v] = best_count
            continue

        poses[best_v] = np.hstack([Rv, tv.reshape(3, 1)])
        reg_order.append(best_v)

        # triangulate this view's not-yet-triangulated tracks against the best co-registered view.
        for tid, t in enumerate(tracks):
            if tid in points3d or best_v not in t:
                continue
            others = [w for w in t if w in poses and w != best_v]
            if not others:
                continue
            # widest baseline co-observer for a well-conditioned triangulation.
            cbest = -poses[best_v][:, :3].T @ poses[best_v][:, 3]
            w = max(others, key=lambda ww: np.linalg.norm((-poses[ww][:, :3].T @ poses[ww][:, 3]) - cbest))
            p1 = keypoints[best_v][t[best_v]][None]
            p2 = keypoints[w][t[w]][None]
            Xn, vn = triangulate_gated(_proj(K, poses[best_v]), _proj(K, poses[w]), p1, p2,
                                       max_px=reproj_gate, min_deg=parallax_gate_deg)
            if vn[0]:
                points3d[tid] = Xn[0]

        since_global += 1
        _run_ba(poses, points3d, tracks, keypoints, K, fix_intrinsics=fix_intrinsics, free_cams=[best_v])
        if since_global >= _GLOBAL_BA_EVERY:
            _run_ba(poses, points3d, tracks, keypoints, K, fix_intrinsics=fix_intrinsics)
            since_global = 0

    # --- final global BA + track-length filter -----------------------------------------------
    _run_ba(poses, points3d, tracks, keypoints, K, fix_intrinsics=fix_intrinsics)
    for tid in list(points3d):
        n_obs = sum(1 for v in tracks[tid] if v in poses)
        if n_obs < 3:  # SPEC-13 §5.4-4: final cloud keeps track length >= 3
            del points3d[tid]

    registered = reg_order
    unreg = [names[v] for v in all_images if v not in poses and v < len(names)]
    return SfmResult(
        poses_w2c=poses,
        points3d=points3d,
        registered=registered,
        unregistered_names=unreg,
        mean_reproj=_mean_reproj(poses, points3d, tracks, keypoints, K),
    )
