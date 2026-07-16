"""Point-cloud / surface-fit losses in pure `mlx.core` — SPEC-12 §5.2 `core/losses.py` row.

Three deterministic (no RNG) fidelity measures that U5.2's gradient refinement and the
FR-9 fit report consume:

  * :func:`chamfer_distance` — StepForge Eq. 1 bidirectional **squared** Chamfer between
    two point clouds, computed in row-blocks so peak memory is ``O(chunk · M)`` rather than
    the full ``O(N · M)`` matrix. This is the **metric / FR-9-report** path: it host-syncs
    (``.item()``) to a Python float and is therefore **not autodiff-usable** — a gradient
    loop (U5.2 ``fit_grad``) must use its own inline differentiable Chamfer.
  * :func:`scaled_chamfer_distance` — the ADR-0001 / StepForge Eq. 2 Scaled Chamfer
    Distance: the bidirectional CD normalized by the target cloud's squared RMS radius, so
    the score is dimensionless and invariant to translation, rotation, and uniform scale.
  * :func:`rms_max_deviation` — the ``(rms, max)`` surface-fit deviation (FR-9), a thin
    pass-through to :func:`app.core.params.deviation` (Newton point projection).

**Provenance (SPEC-12 licensing / ADR-0001).** The Chamfer + SCD *math* is reimplemented
(not copied) from StepForge's ``reward/scd_reward.py`` (Apache-2.0) — the same port ADR-0001
did once for ``services/reconstruct``. StepForge's alignment stage (FPFH+RANSAC+ICP, open3d)
is intentionally dropped: fits live in the mesh's own coordinate frame, so no pose search is
needed (ADR-0001).

**Two-precision policy (SPEC-12 §5.3 / D-9).** float64 is CPU-only in MLX, so every op routes
through ``_stream_for`` (CPU stream for float64, default/GPU stream for float32). The full
pairwise distance matrix is never allocated; each block's ``(chunk, M)`` matrix is evaluated
and freed before the next (``mx.eval`` per block — device-side materialization that does not
change values, so the chunked result is **bitwise identical** to the unchunked one).
"""

import mlx.core as mx

from .basis import _stream_for
from .params import deviation

__all__ = ["chamfer_distance", "rms_max_deviation", "scaled_chamfer_distance"]

# default block size for the Chamfer distance matrix: peak memory is O(chunk · M) floats
_DEFAULT_CHUNK = 2048
# below this RMS radius the target cloud is (numerically) a point — SCD is undefined
_SCALE_FLOOR = 1e-8


def chamfer_distance(a: mx.array, b: mx.array, *, chunk: int = _DEFAULT_CHUNK) -> float:
    """StepForge Eq. 1 bidirectional **squared** Chamfer distance between two clouds.

    ``CD(A, B) = mean_{a∈A} min_{b∈B} ‖a-b‖²  +  mean_{b∈B} min_{a∈A} ‖a-b‖²``

    Squared (not Euclidean) distances are what make :func:`scaled_chamfer_distance`
    dimensionless under the ``/scale²`` normalization. A clean translation by ``d`` (smaller
    than half the point spacing, so every nearest neighbour is the moved copy of the same
    point) therefore yields exactly ``2·d²``; identical clouds yield ``0``.

    **Chunking.** The ``A→B`` direction takes each row's minimum; the ``B→A`` direction keeps
    a running per-column minimum across blocks. Both reductions are invariant to the block
    boundaries — every row minimum is computed over the full ``B`` (columns are never split),
    and ``min`` is exact and associative — so the result is **bitwise identical** to the
    single-block (unchunked) computation. Peak memory is ``O(chunk · M)``: each block's
    ``(chunk, M)`` distance matrix is materialized (``mx.eval``) and freed before the next,
    and no per-block host sync (``.item()``) is done, so the graph never accumulates all
    blocks. One final ``.item()`` reads the scalar out.

    Args:
        a: first cloud, shape ``(N, 3)``, float32 or float64 (float64 runs on the CPU stream).
        b: second cloud, shape ``(M, 3)``, same dtype as ``a``.
        chunk: rows of ``a`` per block (memory/throughput knob only — no effect on the value).

    Returns:
        the bidirectional squared Chamfer distance as a Python float; ``inf`` if either cloud
        is empty (never a silent NaN — FR-6).
    """
    # NOTE: callers must pass a and b with the same dtype; a dtype-match assertion is a
    # pending hardening follow-up.
    n, m = a.shape[0], b.shape[0]
    if n == 0 or m == 0:
        return float("inf")
    step = max(1, chunk)
    with _stream_for(a.dtype):
        row_mins = []  # each block's min over B, per A-row (concatenated -> one mean at the end)
        col_min = None  # running min over A, per B-column (the reverse direction)
        for start in range(0, n, step):
            block = a[start : start + step]
            d2 = mx.sum((block[:, None, :] - b[None, :, :]) ** 2, axis=-1)  # (block, M)
            block_row_min = mx.min(d2, axis=1)  # (block,)
            block_col_min = mx.min(d2, axis=0)  # (M,)
            col_min = block_col_min if col_min is None else mx.minimum(col_min, block_col_min)
            mx.eval(block_row_min, col_min)  # free the (block, M) matrix before the next block
            row_mins.append(block_row_min)
        d_ab = mx.mean(row_mins[0] if len(row_mins) == 1 else mx.concatenate(row_mins))
        d_ba = mx.mean(col_min)
        return float((d_ab + d_ba).item())


def scaled_chamfer_distance(a: mx.array, b: mx.array) -> float:
    """ADR-0001 / StepForge Eq. 2 Scaled Chamfer Distance (alignment dropped — same frame).

    ``SCD(A, B) = CD(A - c, B - c) / scale²``

    where ``c`` is the **target** (``b``) centroid and ``scale`` is the RMS distance of ``b``
    from ``c`` (StepForge §3.3: *"the scale factor is the root-mean-square distance of the
    ground-truth points from their centroid"*). Because :func:`chamfer_distance` is squared,
    ``CD`` scales as ``k²`` and ``scale²`` scales as ``k²`` when both clouds are scaled by
    ``k`` — so ``SCD`` is invariant to uniform scale (and to translation, since both clouds
    are shifted by the same ``c``, and to rotation, since squared distances and the RMS
    radius are rotation-invariant).

    Args:
        a: predicted / fitted cloud, shape ``(N, 3)``.
        b: target cloud, shape ``(M, 3)`` — the centroid and scale come from ``b``.

    Returns:
        the dimensionless SCD as a Python float; ``inf`` if either cloud is empty or ``b`` is
        (numerically) degenerate — ``scale < 1e-8`` (never a silent NaN — FR-6).
    """
    # NOTE: callers must pass a and b with the same dtype; a dtype-match assertion is a
    # pending hardening follow-up.
    if a.shape[0] == 0 or b.shape[0] == 0:
        return float("inf")
    with _stream_for(b.dtype):
        centroid = mx.mean(b, axis=0)
        b_centered = b - centroid
        # a_centered is built on this same stream so its float64 subtraction is never placed
        # on the GPU stream (which rejects float64); chamfer_distance re-enters the CPU stream
        # to evaluate both centered arrays.
        a_centered = a - centroid
        scale = float(mx.sqrt(mx.mean(mx.sum(b_centered * b_centered, axis=-1))).item())
    if scale < _SCALE_FLOOR:
        return float("inf")
    return chamfer_distance(a_centered, b_centered) / (scale ** 2)


def rms_max_deviation(
    points: mx.array,
    poles: mx.array,
    weights: mx.array | None,
    u_knots: mx.array,
    v_knots: mx.array,
    p: int,
    q: int,
) -> tuple[float, float]:
    """``(rms, max)`` surface-fit deviation (FR-9) — a pass-through to :func:`params.deviation`.

    Projects ``points`` onto the NURBS surface (Newton point inversion, §6.1) and returns
    ``rms = sqrt(mean(d²))`` and ``max = max(d)`` over the per-point projection distances
    ``d``. The Chamfer losses above measure fit against a whole cloud; this measures the
    unsigned per-point distance of specific data points to the surface (each ``d`` is a
    Euclidean magnitude ``sqrt(sum(r²)) ≥ 0``, never a signed offset), which the FR-9
    report and the U7.4 accuracy gate consume.

    Args: identical to :func:`app.core.params.deviation`.

    Returns:
        ``(rms, max)`` as Python floats.
    """
    return deviation(points, poles, weights, u_knots, v_knots, p, q)
