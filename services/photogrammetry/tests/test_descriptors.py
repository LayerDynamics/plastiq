"""P1.3 — root-SIFT descriptor (`app.core.features.compute_descriptors`) tests.

Strict-TDD oracle suite for the 128-d Lowe SIFT descriptor with root-SIFT normalization, appended to
the P1.2 detector. The bed is the committed synthetic scene (`tests/synthetic.py`).

Ground-truth correspondence oracle — a documented deviation from the plan (P1.3 said "use
``s.visibility``"): the fixture's 42 *geometric* landmarks (a plane grid + box-face points) almost
never coincide with detected SIFT keypoints (corners/blobs of the procedural texture), so
``s.visibility`` yields only 0-1 *gradeable* matches per pair — a metric even ``cv2.SIFT`` (a
known-correct descriptor) cannot be scored by. We therefore verify a matched pair with the **dense
form of the same fixture ground truth** that ``s.visibility`` samples sparsely: reproject
``kp_a``'s pixel through the fixture's exact per-pixel depth ``s.depths[a]`` and known poses
``s.poses_w2c`` / intrinsics ``s.K`` into view ``b`` and require it to land within ``tol`` px of
``kp_b`` (with a depth-consistency guard against occluded background points). ``s.depths`` /
``s.poses_w2c`` / ``s.K`` are exact by construction (the fixture docstring lists depth maps as a
first-class oracle), so this is stricter and denser than the landmark sampling, not a weaker stand-in.

Baseline — a second documented deviation: the plan said "wide-baseline pair", but on the ±69° /
8-view arc only *adjacent* views (~20° apart, ~1.5-unit camera translation on the r=4.5 arc) match
reliably; every non-adjacent pair defeats classical SIFT for the oracle too (``cv2.SIFT`` scores
<70% GT-precision on every non-adjacent pair, max 64% at 2-step, vs ~86-94% on adjacent pairs). An
adjacent pair here is a genuine stereo baseline — only the extreme arc corners exceed classical
SIFT's viewpoint tolerance — so ``_ADJ_PAIR`` is used for both the correspondence and the parity
test (the parity test requires the *same* pair).

Matcher — an in-test mutual-NN + Lowe-ratio-0.8 matcher (numpy pairwise L2 + argmin), deliberately
*not* importing ``app.core.match`` (a parallel P2.1 agent still owns it).

OpenCV (``cv2``) is imported here as a **test-only** oracle (SPEC-13 D-1); ``app/`` never imports it.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from app.core.features import compute_descriptors, detect, detect_and_describe
from tests.synthetic import make_synthetic_scene

# Permissive detect knobs matching the P1.2 convention: the 96 px value-noise views are genuinely
# sparse at OpenCV-SIFT defaults, so a denser set is drawn by lowering the contrast floor / raising
# the scale count *in the test* (never in the production default). See tests/test_features.py.
_FIXTURE_KW = dict(n_scales=5, contrast_threshold=0.006)

# Adjacent view pair — a genuine ~20° stereo baseline; the only regime where classical SIFT (ours or
# the cv2 oracle) matches reliably on this tiny fixture (see module docstring). Used for BOTH the
# correspondence-recall and the OpenCV-parity tests (parity requires the same pair).
_ADJ_PAIR = (3, 4)


def _scene():
    return make_synthetic_scene(n_views=8, height=96, width=96, seed=0)


def _match_mutual_nn(desc_a: np.ndarray, desc_b: np.ndarray, ratio: float = 0.8) -> np.ndarray:
    """Mutual-nearest-neighbour + Lowe-ratio matcher on two descriptor sets → ``(M, 2)`` (i, j).

    Pure numpy (no ``app.core.match``): pairwise Euclidean distances, per-row argmin for the NN,
    mutual-consistency check, and the Lowe ratio between the two nearest neighbours of each ``a``.
    """
    if desc_a.shape[0] == 0 or desc_b.shape[0] == 0:
        return np.zeros((0, 2), dtype=int)
    a2 = (desc_a * desc_a).sum(axis=1)[:, None]
    b2 = (desc_b * desc_b).sum(axis=1)[None, :]
    d2 = np.maximum(a2 + b2 - 2.0 * desc_a @ desc_b.T, 0.0)
    dist = np.sqrt(d2)  # (Na, Nb)
    nn_ab = np.argmin(dist, axis=1)
    nn_ba = np.argmin(dist, axis=0)
    out = []
    for i in range(desc_a.shape[0]):
        j = int(nn_ab[i])
        if int(nn_ba[j]) != i:  # mutual-NN
            continue
        order = np.argsort(dist[i])
        d1 = dist[i, order[0]]
        d2n = dist[i, order[1]] if dist.shape[1] > 1 else np.inf
        if d1 < ratio * d2n:  # Lowe ratio
            out.append((i, j))
    return np.array(out, dtype=int) if out else np.zeros((0, 2), dtype=int)


def _reproj_gt(scene, va: int, vb: int, xy_a: np.ndarray, xy_b: np.ndarray,
               matches: np.ndarray, tol: float = 2.5, depth_rtol: float = 0.03):
    """Count GT-correct matches by depth reprojection view ``va`` → ``vb`` (dense fixture oracle).

    Returns ``(correct, gradeable)``. A match ``(i, j)`` is *gradeable* if ``kp_a[i]`` has a finite
    scene depth (so it can be reprojected). It is *correct* if the reprojected pixel lands within
    ``tol`` px of ``kp_b[j]`` and is depth-consistent with the surface visible in ``vb`` (guarding
    against a background point reprojecting onto a foreground keypoint by coincidence).
    """
    K = scene.K
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    Ra, ta = scene.poses_w2c[va][:, :3], scene.poses_w2c[va][:, 3]
    Rb, tb = scene.poses_w2c[vb][:, :3], scene.poses_w2c[vb][:, 3]
    depth_a, depth_b = scene.depths[va], scene.depths[vb]
    h, w = depth_a.shape
    correct = gradeable = 0
    for i, j in matches:
        u, v = xy_a[i]
        ri, ci = int(round(v)), int(round(u))
        if not (0 <= ri < h and 0 <= ci < w):
            continue
        d = depth_a[ri, ci]
        if not np.isfinite(d) or d <= 0:
            continue
        gradeable += 1
        xc = np.array([(u - cx) / fx * d, (v - cy) / fy * d, d])
        xw = Ra.T @ (xc - ta)
        xcb = Rb @ xw + tb
        if xcb[2] <= 0:
            continue
        ub = fx * xcb[0] / xcb[2] + cx
        vb_ = fy * xcb[1] / xcb[2] + cy
        rj, cj = int(round(vb_)), int(round(ub))
        if 0 <= rj < h and 0 <= cj < w:  # occlusion / depth-consistency guard
            surf = depth_b[rj, cj]
            if np.isfinite(surf) and abs(surf - xcb[2]) > depth_rtol * xcb[2]:
                continue
        if np.hypot(ub - xy_b[j][0], vb_ - xy_b[j][1]) <= tol:
            correct += 1
    return correct, gradeable


# --- descriptor invariants --------------------------------------------------------------------


def test_descriptor_shape_and_dtype() -> None:
    scene = _scene()
    kps, desc = detect_and_describe(scene.images[0], **_FIXTURE_KW)
    k = kps.xy.shape[0]
    assert k > 0
    assert desc.shape == (k, 128)
    assert desc.dtype == np.float32


def test_descriptor_is_unit_l2_and_nonnegative() -> None:
    """root-SIFT descriptors are element-wise non-negative and (for non-degenerate keypoints) unit
    L2 norm — L1-normalize-then-sqrt sends ``||·||₁ = 1`` to ``||·||₂ = 1``."""
    scene = _scene()
    _, desc = detect_and_describe(scene.images[0], **_FIXTURE_KW)
    assert np.all(desc >= 0.0), "root-SIFT is non-negative (sqrt of non-negative histogram)"
    norms = np.linalg.norm(desc, axis=1)
    # every non-degenerate (nonzero) descriptor is unit L2 norm
    nonzero = norms > 1e-6
    assert nonzero.mean() > 0.99, "essentially all descriptors are non-degenerate"
    np.testing.assert_allclose(norms[nonzero], 1.0, atol=1e-5)


def test_descriptor_is_deterministic() -> None:
    scene = _scene()
    _, a = detect_and_describe(scene.images[0], **_FIXTURE_KW)
    _, b = detect_and_describe(scene.images[0], **_FIXTURE_KW)
    np.testing.assert_array_equal(a, b)


def test_compute_descriptors_matches_detect_then_describe() -> None:
    """The convenience ``detect_and_describe`` equals ``detect`` followed by ``compute_descriptors``."""
    scene = _scene()
    kps = detect(scene.images[0], **_FIXTURE_KW)
    desc = compute_descriptors(scene.images[0], kps, n_scales=_FIXTURE_KW["n_scales"])
    kps2, desc2 = detect_and_describe(scene.images[0], **_FIXTURE_KW)
    np.testing.assert_array_equal(kps.xy, kps2.xy)
    np.testing.assert_array_equal(desc, desc2)


# --- matching / ground-truth recovery ---------------------------------------------------------


def test_mutual_nn_recovers_ground_truth_correspondences() -> None:
    """On an adjacent (genuine ~20° baseline) pair, ≥70% of gradeable mutual-NN + ratio-0.8 matches
    reproject onto the correct keypoint (dense depth GT)."""
    scene = _scene()
    va, vb = _ADJ_PAIR
    kpa, da = detect_and_describe(scene.images[va], **_FIXTURE_KW)
    kpb, db = detect_and_describe(scene.images[vb], **_FIXTURE_KW)
    matches = _match_mutual_nn(da, db, ratio=0.8)
    assert matches.shape[0] >= 15, f"too few matches to judge precision: {matches.shape[0]}"
    correct, gradeable = _reproj_gt(scene, va, vb, kpa.xy, kpb.xy, matches)
    assert gradeable >= 10, f"too few gradeable matches: {gradeable}"
    precision = correct / gradeable
    assert precision >= 0.70, f"GT correspondence precision {precision:.2%} < 70% " \
        f"({correct}/{gradeable} gradeable, {matches.shape[0]} matched)"


def test_opencv_oracle_inlier_parity() -> None:
    """Our detector+descriptor's GT-verified inlier count is ≥60% of ``cv2.SIFT_create()``'s on the
    same adjacent pair, both scored with the same in-test matcher + reprojection GT (SPEC-13 D-1)."""
    cv2 = pytest.importorskip("cv2")
    scene = _scene()
    va, vb = _ADJ_PAIR

    def _cv(img):
        sift = cv2.SIFT_create(nOctaveLayers=_FIXTURE_KW["n_scales"],
                               contrastThreshold=_FIXTURE_KW["contrast_threshold"])
        g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        kps, desc = sift.detectAndCompute(g, None)
        xy = np.array([k.pt for k in kps], dtype=np.float64) if kps else np.zeros((0, 2))
        desc = desc if desc is not None else np.zeros((0, 128), dtype=np.float32)
        return xy, desc.astype(np.float32)

    # ours
    kpa, da = detect_and_describe(scene.images[va], **_FIXTURE_KW)
    kpb, db = detect_and_describe(scene.images[vb], **_FIXTURE_KW)
    m_ours = _match_mutual_nn(da, db, ratio=0.8)
    ours_inliers, _ = _reproj_gt(scene, va, vb, kpa.xy, kpb.xy, m_ours)

    # cv2 oracle, scored identically
    xa, ca = _cv(scene.images[va])
    xb, cb = _cv(scene.images[vb])
    m_cv = _match_mutual_nn(ca, cb, ratio=0.8)
    cv_inliers, _ = _reproj_gt(scene, va, vb, xa, xb, m_cv)

    assert cv_inliers > 0
    assert ours_inliers >= 0.60 * cv_inliers, \
        f"inlier parity: ours {ours_inliers} < 60% of cv2 {cv_inliers}"


# --- real-pair smoke (skip-if-absent) ---------------------------------------------------------

_STONE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "ref", "Photogrammetry-examples", "Stone_Mask", "images",
)


@pytest.mark.skipif(not os.path.isdir(_STONE), reason="ref/Photogrammetry-examples not present")
def test_real_pair_smoke_stone_mask() -> None:
    """The descriptor produces a substantial, cv2-comparable set of real matches on two real
    Stone_Mask photos (local-only smoke). Scored *relative to the cv2 SIFT oracle on the same pair*
    rather than a guessed constant: ours must reach ≥30% of cv2's mutual-NN+ratio match count and a
    ≥150 absolute floor. cv2 legitimately finds more (it detects ~8-11k keypoints uncapped vs our
    max_features cap), so a relative bar is the honest measure of descriptor quality here — the real
    accuracy gate is the P7 SfM identity gate, not this count."""
    from PIL import Image

    cv2 = pytest.importorskip("cv2")
    names = sorted(n for n in os.listdir(_STONE) if n.lower().endswith((".jpg", ".jpeg")))
    assert len(names) >= 2

    def _load(name, max_dim=1200):
        img = Image.open(os.path.join(_STONE, name)).convert("RGB")
        scale = max_dim / max(img.size)
        if scale < 1.0:
            img = img.resize((round(img.size[0] * scale), round(img.size[1] * scale)))
        return np.asarray(img)

    img_a, img_b = _load(names[0]), _load(names[1])
    _, da = detect_and_describe(img_a, max_features=4000, n_scales=3)
    _, db = detect_and_describe(img_b, max_features=4000, n_scales=3)
    ours = _match_mutual_nn(da, db, ratio=0.8).shape[0]

    sift = cv2.SIFT_create()

    def _cv_desc(img):
        _, desc = sift.detectAndCompute(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY), None)
        return desc.astype(np.float32) if desc is not None else np.zeros((0, 128), dtype=np.float32)

    cv_matches = _match_mutual_nn(_cv_desc(img_a), _cv_desc(img_b), ratio=0.8).shape[0]
    assert cv_matches > 0
    assert ours >= 150, f"only {ours} ratio-test matches on the real pair (absolute floor)"
    assert ours >= 0.30 * cv_matches, f"real-pair parity: ours {ours} < 30% of cv2 {cv_matches}"
