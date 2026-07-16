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


def select_init_pairs(pair_matches, keypoints, K, top_k: int = 8) -> list:
    """The top-``top_k`` candidate initial pairs, best :func:`init_pair_score` first (deterministic).

    :func:`reconstruct` tries these in order with fallback: the single best pair can still fail the
    essential/triangulation bootstrap on real photos (a narrow or degenerate baseline that the
    fundamental-based score didn't catch), and stranding the whole reconstruction on one bad seed is
    the failure that made geometric verification regress. Returning ranked alternatives makes the seed
    robust. Pairs scoring 0 (too few matches / degenerate) are dropped."""
    scored = []
    for (i, j, matches) in pair_matches:
        m = np.asarray(matches).reshape(-1, 2)
        score = init_pair_score(m, keypoints[i], keypoints[j], K)
        if score > 0.0:
            scored.append(((score, m.shape[0]), (int(i), int(j))))
    scored.sort(key=lambda s: s[0], reverse=True)
    return [pair for _key, pair in scored[:top_k]]


def verify_pair_matches(pair_matches, keypoints, *, seed: int = 0, threshold: float = 2.0,
                        min_inliers: int = 15):
    """Geometrically verify each image pair's raw matches, keeping only the inlier correspondences.

    COLMAP's geometric-verification step, run BEFORE union-find track building: raw mutual-NN +
    Lowe-ratio matches carry geometric outliers, and track construction propagates a single wrong
    match into a contaminated multi-view track — which on real photos collapses PnP inlier ratios
    (registration stalls despite the views sharing hundreds of matches) and injects wrong 3D points.
    RANSAC a fundamental matrix per pair and keep its inliers; drop a pair retaining fewer than
    ``min_inliers`` (weak/spurious overlap). Deterministic via ``seed`` (D-10)."""
    verified = []
    for (i, j, m) in pair_matches:
        m = np.asarray(m).reshape(-1, 2)
        if m.shape[0] < _MIN_FUNDAMENTAL:
            continue
        p1 = np.asarray(keypoints[i], dtype=np.float64)[m[:, 0]]
        p2 = np.asarray(keypoints[j], dtype=np.float64)[m[:, 1]]
        _, mask = ransac_fundamental(p1, p2, seed=seed, threshold=threshold)
        inliers = m[np.asarray(mask, dtype=bool)]
        if inliers.shape[0] >= min_inliers:
            verified.append((int(i), int(j), inliers))
    return verified


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
from app.core.ransac import ransac_essential, ransac_fundamental, ransac_pnp  # noqa: E402
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


def _run_ba(poses, points3d, tracks, keypoints, K, *, fix_intrinsics, free_cams=None,
            cam_subset=None, point_subset=None):
    """Bundle-adjust the current reconstruction in place (poses + points updated).

    ``cam_subset`` / ``point_subset`` restrict the problem to a window of cameras / points (a windowed
    *local* BA — see :func:`_run_local_ba`); ``None`` uses the whole reconstruction (a *global* BA)."""
    reg = sorted(poses if cam_subset is None else [v for v in cam_subset if v in poses])
    tids = sorted(points3d if point_subset is None else [t for t in point_subset if t in points3d])
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
    if free_cams is None:
        # Global BA: hold the reference camera (index 0 = the lowest-id registered view) fixed to
        # anchor the coordinate-frame gauge. With EVERY camera free the reconstruction can rotate/
        # translate at zero reprojection cost (the normal equations are rank-deficient in those 6
        # gauge directions), so scipy's trust-region solver drifts along the gauge and grinds to
        # ``max_nfev`` without converging — the pathological BA runtime that stalled the real-photo
        # gate. Anchoring one camera removes the pose gauge; the residual global-scale null-space has
        # exactly zero gradient (reprojection is scale-invariant), so the solver never steps along it.
        # Local BA (``free_cams`` given) is already gauge-anchored by its held cameras.
        free: list | None = list(range(1, len(reg)))
    else:
        free = [cam_index[v] for v in free_cams if v in cam_index]
    x_opt, _ = run_bundle_adjustment(
        x0, obs, len(reg), len(tids), fix_intrinsics=fix_intrinsics, free_cams=free
    )
    _, cam2, pts2 = unpack(x_opt, len(reg), len(tids))
    for v, i in cam_index.items():
        poses[v] = np.hstack([rodrigues(cam2[i, :3]), cam2[i, 3:].reshape(3, 1)])
    for tid in tids:
        points3d[tid] = pts2[pt_index[tid]]


def _run_local_ba(poses, points3d, tracks, keypoints, K, new_view, *, fix_intrinsics):
    """Windowed local BA after registering ``new_view``: refine only ``new_view``'s pose + the points
    it observes, against its covisible (held-fixed) cameras. Bounds each registration's BA to the new
    camera's neighbourhood so the mapper stays fast as the model grows (COLMAP's local BA) instead of
    re-optimizing every point on every registration — the O(registrations × all-points) cost that made
    a 48-image solve take ~an hour."""
    point_subset = [tid for tid in points3d if new_view in tracks[tid]]
    if not point_subset:
        return
    cam_subset = sorted({v for tid in point_subset for v in tracks[tid] if v in poses})
    _run_ba(poses, points3d, tracks, keypoints, K, fix_intrinsics=fix_intrinsics,
            free_cams=[new_view], cam_subset=cam_subset, point_subset=point_subset)


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


def _filter_high_reproj_points(poses, points3d, tracks, keypoints, K, max_px) -> int:
    """Delete points whose MEAN reprojection error over registered views exceeds ``max_px``, returning
    the count removed. Accepting marginal views on real photos (the absolute-inlier gate) pulls in
    track-merge-contaminated structure that triangulates to the wrong 3D point and reprojects badly in
    every view; those outliers dominate the mean reprojection error. This is the COLMAP filter-points
    step — run in a filter→re-BA loop so the surviving cloud is accurate and the pose fit is honest."""
    removed = 0
    for tid in list(points3d):
        Xh = np.append(points3d[tid], 1.0)
        errs = []
        for v, feat in tracks[tid].items():
            if v in poses:
                p = _proj(K, poses[v]) @ Xh
                if p[2] > 1e-9:
                    errs.append(float(np.linalg.norm(p[:2] / p[2] - keypoints[v][feat])))
        if not errs or float(np.mean(errs)) > max_px:
            del points3d[tid]
            removed += 1
    return removed


def _seed_from_pair(i0, j0, tracks, keypoints, K, *, seed, reproj_gate, parallax_gate_deg):
    """Two-view seed for pair ``(i0, j0)``: RANSAC essential + cheirality pose, then gated
    triangulation of the shared tracks. Returns ``(poses, points3d)`` or ``(None, None)`` when the pair
    is too weak to bootstrap (too few shared tracks, a degenerate essential recovery, or no
    triangulated structure) — the caller then falls back to the next-ranked candidate."""
    both = [(tid, t) for tid, t in enumerate(tracks) if i0 in t and j0 in t]
    if len(both) < _MIN_FUNDAMENTAL:
        return None, None
    pts_i = np.array([keypoints[i0][t[i0]] for _, t in both], dtype=np.float64)
    pts_j = np.array([keypoints[j0][t[j0]] for _, t in both], dtype=np.float64)
    try:
        _, R, t, _ = ransac_essential(pts_i, pts_j, K, K, seed=seed, threshold=reproj_gate)
    except (ValueError, np.linalg.LinAlgError):
        return None, None
    poses = {i0: np.hstack([np.eye(3), np.zeros((3, 1))]), j0: np.hstack([R, t.reshape(3, 1)])}
    tids0 = [tid for tid, _ in both]
    X0, valid0 = triangulate_gated(_proj(K, poses[i0]), _proj(K, poses[j0]), pts_i, pts_j,
                                   max_px=reproj_gate, min_deg=parallax_gate_deg)
    points3d = {tids0[k]: X0[k] for k in range(len(tids0)) if valid0[k]}
    return poses, points3d


def reconstruct(tracks, keypoints, K, *, init_pair, init_candidates=None, image_names=None, seed=0,
                fix_intrinsics=True, min_pnp=6, reproj_gate=4.0, parallax_gate_deg=1.5,
                min_reg_inliers=12, min_init_points=20):
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

    # --- seed from the init pair, with ranked fallbacks --------------------------------------
    # Two-view init on real photos (RANSAC essential + cheirality + gated triangulation) can fail on a
    # narrow/degenerate top pair; try the ranked candidates until one bootstraps enough structure so a
    # single bad seed can't strand the reconstruction.
    candidates = [(int(c[0]), int(c[1])) for c in (init_candidates if init_candidates else [(i0, j0)])]
    poses: dict | None = None
    points3d: dict = {}
    reg_order: list = []
    for (ci, cj) in candidates:
        p, pts = _seed_from_pair(ci, cj, tracks, keypoints, K, seed=seed, reproj_gate=reproj_gate,
                                 parallax_gate_deg=parallax_gate_deg)
        if p is not None and len(pts) >= min_init_points:
            poses, points3d, reg_order = p, pts, [ci, cj]
            break
    if poses is None:  # none cleared the bar — take the strongest available seed (best-effort)
        for (ci, cj) in candidates:
            p, pts = _seed_from_pair(ci, cj, tracks, keypoints, K, seed=seed, reproj_gate=reproj_gate,
                                     parallax_gate_deg=parallax_gate_deg)
            if p is not None and pts:
                poses, points3d, reg_order = p, pts, [ci, cj]
                break
    if poses is None:
        raise ValueError("no candidate initial pair could bootstrap the reconstruction")

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
        # Accept on an ABSOLUTE inlier count (COLMAP's abs_pose_min_num_inliers), not a ratio: on real
        # photos the 2D-3D correspondence set is heavily contaminated by track-merge errors, so a
        # correctly-registered view routinely shows only 10-40% PnP inliers — yet 20-100 absolute
        # inliers at the reprojection gate is a strong, non-coincidental geometric consensus that pins
        # the pose (PnP needs 6). A ratio gate (the old 30%) rejected these and stalled the mapper at
        # the init cluster; the absolute gate lets it grow. Bad poses are still caught downstream (the
        # per-track reprojection/parallax triangulation gates + the local BA + the final track-length
        # filter), so a spurious registration cannot silently corrupt the cloud.
        if n_in < max(min_pnp, min_reg_inliers):  # too few inliers ⇒ retry when evidence grows
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
        _run_local_ba(poses, points3d, tracks, keypoints, K, best_v, fix_intrinsics=fix_intrinsics)
        if since_global >= _GLOBAL_BA_EVERY:
            _run_ba(poses, points3d, tracks, keypoints, K, fix_intrinsics=fix_intrinsics)
            since_global = 0

    # --- final global BA, then filter high-reprojection outliers in a filter→re-BA loop ---------
    _run_ba(poses, points3d, tracks, keypoints, K, fix_intrinsics=fix_intrinsics)
    for _ in range(3):  # COLMAP-style: remove contaminated structure, re-solve, repeat until clean
        if _filter_high_reproj_points(poses, points3d, tracks, keypoints, K, reproj_gate) == 0:
            break
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
