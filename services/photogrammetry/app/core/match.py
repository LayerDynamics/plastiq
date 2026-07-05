"""Descriptor matching — the P2.1 correspondence floor.

Classical two-view descriptor matching for the SfM front-end: given two sets of (root-SIFT-style,
L2-normalized) descriptors, find the mutually-consistent index pairs that pass Lowe's ratio test,
and schedule which image pairs to match across a whole set (exhaustive, or a sequential window for
ordered captures).

Numerics (docs/adr/0013 D-9): the pairwise **distance matrix** is the one heavy step and runs in
``mlx.core`` **float32** on the GPU as a single matmul — for L2-normalized descriptors the squared-L2
distance is ``2 − 2·(d1 · d2ᵀ)``, so ``desc1 @ desc2ᵀ`` yields it with gather + matmul only (no
scatter — scatter is non-deterministic). The comparatively cheap index bookkeeping (nearest-neighbour
argmin/argsort, ratio test, mutual-NN consistency) runs in float64 numpy. There is no RNG anywhere
and the tie-break order is fixed (stable sort, lowest index wins), so two ``match_descriptors`` runs
on the same input return identical index arrays (D-10). OpenCV is a *test-only* oracle (D-1) and is
never imported here.

Key contract decisions (consumed by the P5 incremental mapper):

* **Ratio is Euclidean.** Lowe's 0.8 threshold is compared against the ratio of **Euclidean**
  distances (best / second-best), i.e. the post-``sqrt`` distances — *not* the raw ``2 − 2·dot``
  squared distances. Applying 0.8 to squared distances would be a materially looser ≈0.89 Euclidean
  threshold; the faithful Lowe reading is the Euclidean one.
* **Inputs are L2-normalized defensively** inside :func:`match_descriptors` (a no-op on real
  root-SIFT descriptors) so the ``2 − 2·dot`` identity always holds.
* **Single-candidate degeneracy:** if ``desc2`` has exactly one descriptor there is no second-best,
  so the ratio test cannot reject and every ``desc1`` row's NN is that lone descriptor (the mutual
  and downstream geometry stages still filter). This is degenerate but harmless.
* **:func:`match_image_set` returns *every* scheduled pair**, including pairs whose match array is
  empty (shape ``(0, 2)``) — the mapper receives the full schedule and filters, rather than the
  matcher hiding weak pairs.

Algorithm reimplemented (no code copied) with attribution: Lowe, *Distinctive Image Features from
Scale-Invariant Keypoints*, IJCV 2004 (the distance-ratio test); the mutual-NN + ratio combination
follows kornia ``kornia/feature/matching.py`` (Apache-2.0), which in turn follows Lowe.
"""

from __future__ import annotations

import mlx.core as mx
import numpy as np

__all__ = [
    "match_descriptors",
    "exhaustive_pairs",
    "sequential_pairs",
    "match_image_set",
]

_EPS = 1e-12  # guards the L2-normalization divide for (near-)zero descriptors


def _l2_normalize(desc: np.ndarray) -> np.ndarray:
    """Return ``desc`` as a float64 ``(N, D)`` array with unit-norm rows (zero-safe)."""
    d = np.asarray(desc, dtype=np.float64)
    if d.ndim != 2:
        raise ValueError(f"descriptors must be a 2-D (N, D) array, got shape {d.shape}")
    norms = np.linalg.norm(d, axis=1, keepdims=True)
    return d / np.maximum(norms, _EPS)


def _distance_matrix(desc1: np.ndarray, desc2: np.ndarray) -> np.ndarray:
    """Pairwise Euclidean distance ``(N, M)`` via the MLX float32 matmul identity ``d² = 2 − 2·dot``.

    ``desc1`` / ``desc2`` are unit-norm rows, so the dot product ``desc1 @ desc2ᵀ`` gives the cosine
    similarity and ``2 − 2·sim`` the squared-L2 distance; a numeric clip guards the tiny negative
    values float32 can produce for (near-)identical vectors before the ``sqrt``.
    """
    a = mx.array(desc1.astype(np.float32))
    b = mx.array(desc2.astype(np.float32))
    sim = a @ b.T
    dist2 = 2.0 - 2.0 * sim
    mx.eval(dist2)
    d2 = np.array(dist2, dtype=np.float64)
    np.clip(d2, 0.0, None, out=d2)
    return np.sqrt(d2)


def match_descriptors(
    desc1: np.ndarray,
    desc2: np.ndarray,
    ratio: float = 0.8,
    mutual: bool = True,
) -> np.ndarray:
    """Match two descriptor sets → ``(P, 2)`` int index pairs ``(i, j)`` (``i`` in desc1, ``j`` in desc2).

    For each ``desc1`` row the nearest and second-nearest ``desc2`` descriptors are found; the pair
    to the nearest is kept when Lowe's **Euclidean** distance ratio ``best / second_best < ratio``
    (0.8). When ``mutual`` is true, a kept pair ``(i, j)`` additionally requires that ``i`` is the
    nearest ``desc1`` row to ``j`` (mutual nearest-neighbour consistency). Pairs are returned sorted
    by ``(i, j)`` for determinism. Empty inputs (or no surviving matches) yield a ``(0, 2)`` array.
    """
    d1 = _l2_normalize(desc1)
    d2 = _l2_normalize(desc2)
    n, m = d1.shape[0], d2.shape[0]
    if n == 0 or m == 0:
        return np.empty((0, 2), dtype=np.int64)

    dist = _distance_matrix(d1, d2)  # (n, m) Euclidean

    # Nearest / second-nearest per desc1 row via a stable sort (lowest index wins ties).
    order = np.argsort(dist, axis=1, kind="stable")  # (n, m)
    rows = np.arange(n)
    nn = order[:, 0]  # nearest desc2 index per desc1 row
    best_d = dist[rows, nn]
    if m >= 2:
        second_d = dist[rows, order[:, 1]]
    else:
        second_d = np.full(n, np.inf)  # no second-best ⇒ ratio cannot reject

    ratio_ok = best_d < ratio * second_d

    if mutual:
        # Nearest desc1 row per desc2 column; keep only where it points back to this row.
        nn_back = np.argmin(dist, axis=0)  # (m,)
        mutual_ok = nn_back[nn] == rows
        keep = ratio_ok & mutual_ok
    else:
        keep = ratio_ok

    pairs = np.stack([rows[keep], nn[keep]], axis=1).astype(np.int64)
    if pairs.shape[0] == 0:
        return np.empty((0, 2), dtype=np.int64)
    # Deterministic order: sort by (i, j). rows are already ascending; sort by j within each i.
    order_out = np.lexsort((pairs[:, 1], pairs[:, 0]))
    return pairs[order_out]


def exhaustive_pairs(n: int) -> list[tuple[int, int]]:
    """All ``(i, j)`` image index pairs with ``i < j`` — the exhaustive matching schedule."""
    return [(i, j) for i in range(n) for j in range(i + 1, n)]


def sequential_pairs(n: int, window: int = 8) -> list[tuple[int, int]]:
    """``(i, j)`` pairs with ``0 < j − i ≤ window`` — the sequential/ordered-capture schedule.

    A ``window`` ≥ ``n − 1`` degenerates to :func:`exhaustive_pairs` (every pair is within reach).
    """
    if window < 1:
        raise ValueError(f"window must be >= 1, got {window}")
    return [(i, j) for i in range(n) for j in range(i + 1, min(i + window + 1, n))]


def match_image_set(
    descriptors_list: list[np.ndarray],
    schedule: str = "exhaustive",
    window: int = 8,
    ratio: float = 0.8,
) -> list[tuple[int, int, np.ndarray]]:
    """Match a whole descriptor set → ``[(i, j, matches)]`` over the chosen pair schedule.

    ``schedule`` is ``"exhaustive"`` (all ``i < j``) or ``"sequential"`` (``|i − j| ≤ window``).
    Every scheduled pair is returned — including pairs whose ``matches`` array is empty (shape
    ``(0, 2)``) — so the downstream mapper sees the full schedule. Matching uses mutual-NN + the
    Lowe ratio (the :func:`match_descriptors` defaults).
    """
    n = len(descriptors_list)
    if schedule == "exhaustive":
        schedule_pairs = exhaustive_pairs(n)
    elif schedule == "sequential":
        schedule_pairs = sequential_pairs(n, window=window)
    else:
        raise ValueError(f"unknown schedule {schedule!r}; expected 'exhaustive' or 'sequential'")

    results: list[tuple[int, int, np.ndarray]] = []
    for i, j in schedule_pairs:
        matches = match_descriptors(descriptors_list[i], descriptors_list[j], ratio=ratio, mutual=True)
        results.append((i, j, matches))
    return results
