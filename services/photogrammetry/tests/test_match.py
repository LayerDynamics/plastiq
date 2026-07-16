"""P2.1 — descriptor matching (`app.core.match`) tests.

Strict-TDD suite for the classical descriptor matcher: MLX matmul distance matrices, Lowe's ratio
test (0.8), mutual nearest-neighbour consistency, and the exhaustive / sequential-window pair
schedules that drive `match_image_set`.

These tests use **planted / synthetic descriptor arrays constructed here** — never the real SIFT
descriptor (P1.3 `app.core.features`) — so P2.1 is validated independently of the detector. The
full features → descriptor → match chain is exercised later (P5 / the P7 gate).

Two descriptor constructions are used:

* **High-dimensional random unit vectors** (``_rand_unit``, seeded ``np.random.default_rng``) for the
  planted-recovery and determinism cases — well-separated in 128-d, so the nearest neighbour of a
  lightly-noised copy is unambiguous.
* **2-D unit vectors from angles** (``_unit``) for the ratio and mutual-NN cases — in 2-D the L2
  distance ``2·sin(Δθ/2)`` is monotone in the angle gap, so the exact NN / ratio structure is
  hand-computable and can be planted precisely.

Reference: Lowe, *Distinctive Image Features from Scale-Invariant Keypoints*, IJCV 2004 (the 0.8
distance-ratio test); the mutual-NN + ratio combination follows kornia's ``feature/matching.py``
(Apache-2.0), reimplemented — no code copied.
"""

from __future__ import annotations

import numpy as np

from app.core.match import (
    exhaustive_pairs,
    match_descriptors,
    match_image_set,
    sequential_pairs,
)


def _unit(angles_deg) -> np.ndarray:
    """2-D unit vectors (rows) from a sequence of angles in degrees."""
    a = np.deg2rad(np.asarray(angles_deg, dtype=np.float64))
    return np.stack([np.cos(a), np.sin(a)], axis=1)


def _rand_unit(rng: np.random.Generator, n: int, d: int) -> np.ndarray:
    """``n × d`` L2-normalized random Gaussian rows (root-SIFT-like unit descriptors)."""
    x = rng.standard_normal((n, d))
    return x / np.linalg.norm(x, axis=1, keepdims=True)


# --- planted recovery -----------------------------------------------------------------------------


def test_planted_permutation_recovered() -> None:
    """A shuffled, lightly-noised copy of a descriptor set is re-matched to its source permutation.

    ``desc2 = desc1[perm] + small noise`` ⇒ the correct pair for source row ``i`` is the column
    ``j`` with ``perm[j] == i``. On well-separated 128-d unit vectors the matcher recovers (almost)
    the whole permutation, and every pair it *does* return is correct (high precision).
    """
    rng = np.random.default_rng(0)
    n, d = 30, 128
    desc1 = _rand_unit(rng, n, d)
    perm = rng.permutation(n)
    noise = 0.01 * rng.standard_normal((n, d))
    desc2 = desc1[perm] + noise
    desc2 = desc2 / np.linalg.norm(desc2, axis=1, keepdims=True)

    pairs = match_descriptors(desc1, desc2, ratio=0.8, mutual=True)

    assert pairs.ndim == 2 and pairs.shape[1] == 2
    correct = int(np.sum(perm[pairs[:, 1]] == pairs[:, 0]))
    recall = correct / n
    precision = correct / max(len(pairs), 1)
    assert recall >= 0.8, f"recall {recall:.3f} too low"
    assert precision >= 0.9, f"precision {precision:.3f} too low"


# --- ratio test -----------------------------------------------------------------------------------


def test_ratio_rejects_ambiguous_keeps_clear() -> None:
    """A near-equidistant two-NN query is rejected by the 0.8 ratio; a clear-NN query is kept."""
    # Ambiguous: query at 45° is 5° from both candidates → ratio ≈ 1.0 → rejected.
    ambiguous = match_descriptors(_unit([45.0]), _unit([40.0, 50.0]), ratio=0.8)
    assert len(ambiguous) == 0

    # Clear: query at 41° is 1° from c0, 49° from c1 → ratio ≈ 0.02 → kept as (0, 0).
    clear = match_descriptors(_unit([41.0]), _unit([40.0, 90.0]), ratio=0.8)
    assert clear.tolist() == [[0, 0]]


def test_ratio_uses_euclidean_not_squared_distance() -> None:
    """Pins Lowe's ratio to **Euclidean** distances, not the raw ``2−2·dot`` squared distances.

    Query at 0°; c0 at 34° (d ≈ 0.5847), c1 at −40° (d ≈ 0.6840). The Euclidean ratio ≈ 0.855 > 0.8
    ⇒ **rejected**. Were the ratio applied to *squared* distances the ratio would be ≈ 0.731 < 0.8
    ⇒ kept — so an empty result here is only possible with the faithful Euclidean comparison.
    """
    q = _unit([0.0])
    cand = _unit([34.0, -40.0])
    result = match_descriptors(q, cand, ratio=0.8, mutual=False)
    assert len(result) == 0


# --- mutual nearest neighbour ---------------------------------------------------------------------


def test_mutual_nn_excludes_asymmetric_pair() -> None:
    """An asymmetric NN pair is dropped when ``mutual=True`` and kept when ``mutual=False``.

    desc1 rows r0=20°, r1=5°; desc2 cols c0=0°, c1=90°. Both rows' NN is c0 (ratio passes), but
    c0's own NN is r1 (closer), so (r0, c0) is asymmetric: present without mutual, absent with it.
    (r1, c0) is a genuine mutual pair and survives both.
    """
    desc1 = _unit([20.0, 5.0])
    desc2 = _unit([0.0, 90.0])

    with_mutual = match_descriptors(desc1, desc2, ratio=0.8, mutual=True).tolist()
    without_mutual = match_descriptors(desc1, desc2, ratio=0.8, mutual=False).tolist()

    assert [0, 0] in without_mutual  # r0 → c0 is a one-directional NN
    assert [0, 0] not in with_mutual  # …but c0 → r1, so mutual drops it
    assert [1, 0] in with_mutual  # r1 ↔ c0 is mutual
    assert [1, 0] in without_mutual


# --- pair schedules -------------------------------------------------------------------------------


def test_exhaustive_pairs_count_and_content() -> None:
    pairs = exhaustive_pairs(5)
    assert len(pairs) == 10  # C(5, 2)
    assert pairs == [(0, 1), (0, 2), (0, 3), (0, 4), (1, 2), (1, 3),
                     (1, 4), (2, 3), (2, 4), (3, 4)]
    # all i < j, unique
    assert all(i < j for i, j in pairs)
    assert len(set(pairs)) == len(pairs)


def test_exhaustive_pairs_edges() -> None:
    assert exhaustive_pairs(0) == []
    assert exhaustive_pairs(1) == []
    assert exhaustive_pairs(2) == [(0, 1)]


def test_sequential_pairs_window() -> None:
    pairs = sequential_pairs(6, window=2)
    assert pairs == [(0, 1), (0, 2), (1, 2), (1, 3), (2, 3), (2, 4),
                     (3, 4), (3, 5), (4, 5)]
    assert all(i < j and (j - i) <= 2 for i, j in pairs)


def test_sequential_pairs_window_one_is_adjacency() -> None:
    assert sequential_pairs(6, window=1) == [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5)]


def test_sequential_pairs_edges() -> None:
    assert sequential_pairs(0, window=8) == []
    assert sequential_pairs(1, window=8) == []
    # a window ≥ n-1 degenerates to exhaustive
    assert sequential_pairs(4, window=8) == exhaustive_pairs(4)


# --- match_image_set ------------------------------------------------------------------------------


def test_match_image_set_exhaustive_structure() -> None:
    """Exhaustive schedule returns every scheduled pair (including low-match ones) as (i, j, M)."""
    rng = np.random.default_rng(3)
    base = _rand_unit(rng, 12, 16)
    perm = rng.permutation(12)
    img1 = base[perm] + 0.005 * rng.standard_normal((12, 16))
    img1 = img1 / np.linalg.norm(img1, axis=1, keepdims=True)
    img2 = _rand_unit(rng, 12, 16)  # unrelated

    results = match_image_set([base, img1, img2], schedule="exhaustive")

    assert [(i, j) for i, j, _ in results] == exhaustive_pairs(3)
    by_pair = {(i, j): m for i, j, m in results}
    m01 = by_pair[(0, 1)]
    assert m01.ndim == 2 and m01.shape[1] == 2
    assert len(m01) >= 8  # the near-copy pair matches strongly


def test_match_image_set_sequential_structure() -> None:
    rng = np.random.default_rng(4)
    imgs = [_rand_unit(rng, 5, 16) for _ in range(5)]
    results = match_image_set(imgs, schedule="sequential", window=1)
    assert [(i, j) for i, j, _ in results] == sequential_pairs(5, 1)
    assert all(m.ndim == 2 and m.shape[1] == 2 for _, _, m in results)


def test_match_image_set_rejects_unknown_schedule() -> None:
    rng = np.random.default_rng(5)
    imgs = [_rand_unit(rng, 4, 8) for _ in range(2)]
    try:
        match_image_set(imgs, schedule="bogus")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for unknown schedule")


# --- determinism ----------------------------------------------------------------------------------


def test_matching_is_deterministic() -> None:
    rng = np.random.default_rng(7)
    desc1 = _rand_unit(rng, 40, 128)
    perm = rng.permutation(40)
    desc2 = desc1[perm] + 0.02 * rng.standard_normal((40, 128))
    desc2 = desc2 / np.linalg.norm(desc2, axis=1, keepdims=True)

    a = match_descriptors(desc1, desc2, ratio=0.8, mutual=True)
    b = match_descriptors(desc1, desc2, ratio=0.8, mutual=True)
    assert np.array_equal(a, b)
