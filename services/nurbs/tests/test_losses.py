"""U5.1 — tests for `app/core/losses.py`: chunked Chamfer, SCD, rms/max deviation.

Deterministic fixed data only (no RNG anywhere). All arrays are float64 built with an
explicit dtype (MLX silently downcasts float64 numpy input to float32 otherwise, §5.3),
so every op runs on the CPU stream. Point clouds are SMALL (tens of points) — the suite
runs in seconds.

  * ``chamfer_distance`` is the StepForge Eq. 1 bidirectional **squared** Chamfer
    (``mean_a min_b ||a-b||² + mean_b min_a ||a-b||²``), so a clean small translation by
    ``d`` gives exactly ``2·d²`` (both mean-squared directions). Squared — not Euclidean —
    is what makes SCD (``/scale²``) dimensionless/scale-invariant.
      - identical clouds → 0 exactly;
      - clean small offset ``d`` → ``2·d²`` (translation smaller than half the point spacing
        so every nearest neighbour is the translated copy of the same point);
      - chunked ≡ unchunked **bitwise** (row-mins concatenated + one mean; running column
        min — both invariant to chunk size, and ``min`` is exact);
      - symmetric in its two arguments.
  * ``scaled_chamfer_distance`` = ``CD(pred - c, gt - c) / scale²`` with ``c`` the **gt**
    centroid and ``scale`` the RMS distance of gt from ``c`` (ADR-0001 / StepForge Eq. 2,
    alignment dropped — same coordinate frame):
      - invariant under scaling BOTH clouds by k (scaled UP by 1e3 so ``scale`` never nears
        the 1e-8 degeneracy floor) to 1e-10;
      - a hand-built small case matches an independent numpy reference.
  * ``rms_max_deviation`` is a thin pass-through to :func:`app.core.params.deviation`:
      - points sampled ON the surface → (rms, max) ≈ 0;
      - points offset ``d`` along the unit normal → (rms, max) ≈ ``d`` (numpy-known offset);
      - returns bitwise exactly what ``params.deviation`` returns (same signature);
      - two identical calls are bitwise identical (f64 on the CPU stream, no RNG).
"""

import math

import mlx.core as mx
import numpy as np

from app.core.eval import surface_derivs, surface_point
from app.core.losses import chamfer_distance, rms_max_deviation, scaled_chamfer_distance
from app.core.params import deviation


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


# --- numpy references (squared distances; centre by the GT centroid) --------------------------


def _np_chamfer(a: np.ndarray, b: np.ndarray) -> float:
    d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=-1)  # (N, M) squared distances
    return float(d2.min(axis=1).mean() + d2.min(axis=0).mean())


def _np_scd(pred: np.ndarray, gt: np.ndarray) -> float:
    c = gt.mean(axis=0)
    gt_c = gt - c
    scale = math.sqrt(np.mean(np.sum(gt_c ** 2, axis=1)))
    return _np_chamfer(pred - c, gt_c) / scale ** 2


# --- fixed point clouds (well spaced, spacing 1.0) --------------------------------------------


def _grid_cloud() -> np.ndarray:
    """4x4 grid in the z=0 plane, spacing 1.0 (min inter-point distance = 1.0)."""
    return np.array([[float(x), float(y), 0.0] for x in range(4) for y in range(4)])


def _cloud_b() -> np.ndarray:
    """A distinct, deterministic 9-point cloud for symmetry / chunking tests."""
    return np.array(
        [[0.3 * i, 0.2 * j, 0.1 * math.sin(i + j)] for i in range(3) for j in range(3)]
    )


# --- Chamfer ----------------------------------------------------------------------------------


def test_chamfer_identical_is_zero():
    a = _mx64(_grid_cloud())
    assert chamfer_distance(a, a) == 0.0


def test_chamfer_known_offset_gives_two_d_squared():
    # translation smaller than half the 1.0 spacing => each nearest neighbour is the
    # translated copy of the same point => squared bidirectional CD = 2 * d^2.
    d = 0.01
    a_np = _grid_cloud()
    b_np = a_np + np.array([d, 0.0, 0.0])
    got = chamfer_distance(_mx64(a_np), _mx64(b_np))
    assert abs(got - 2.0 * d ** 2) < 1e-12
    # and the numpy reference agrees
    assert abs(got - _np_chamfer(a_np, b_np)) < 1e-12


def test_chamfer_chunked_equals_unchunked_bitwise():
    a = _mx64(_grid_cloud())            # 16 points
    b = _mx64(_cloud_b())               # 9 points
    full = chamfer_distance(a, b, chunk=1000)
    chunked = chamfer_distance(a, b, chunk=3)
    tiny = chamfer_distance(a, b, chunk=1)
    assert chunked == full             # bitwise
    assert tiny == full                # bitwise
    assert abs(full - _np_chamfer(_grid_cloud(), _cloud_b())) < 1e-12


def test_chamfer_symmetric():
    a = _mx64(_grid_cloud())
    b = _mx64(_cloud_b())
    assert abs(chamfer_distance(a, b) - chamfer_distance(b, a)) < 1e-12


# --- Scaled Chamfer Distance ------------------------------------------------------------------


def test_scd_scale_invariance():
    pred_np = _grid_cloud() + np.array([0.02, -0.01, 0.03])  # a small rigid-ish perturbation
    gt_np = _grid_cloud()
    base = scaled_chamfer_distance(_mx64(pred_np), _mx64(gt_np))
    for k in (1e3, 1e6):
        scaled = scaled_chamfer_distance(_mx64(k * pred_np), _mx64(k * gt_np))
        assert np.isfinite(base) and base > 0.0
        np.testing.assert_allclose(scaled, base, rtol=1e-10, atol=1e-12)


def test_scd_matches_numpy_reference():
    pred_np = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.2], [0.0, 1.0, -0.1], [1.0, 1.0, 0.05]])
    gt_np = np.array([[0.05, 0.0, 0.0], [1.1, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.05, 0.0]])
    got = scaled_chamfer_distance(_mx64(pred_np), _mx64(gt_np))
    np.testing.assert_allclose(got, _np_scd(pred_np, gt_np), rtol=1e-12, atol=1e-14)


# --- FR-6 degeneracy guards (return inf, never a silent NaN) ----------------------------------


def _empty64() -> mx.array:
    # empty (0, 3) float64 cloud, built like _mx64 so it stays on the CPU (float64) stream
    return _mx64(np.zeros((0, 3)))


def test_chamfer_empty_cloud_is_inf():
    got = chamfer_distance(_empty64(), _mx64(_grid_cloud()))
    assert got == float("inf") and math.isinf(got)
    assert not math.isnan(got)


def test_scd_empty_cloud_is_inf():
    got = scaled_chamfer_distance(_empty64(), _mx64(_grid_cloud()))
    assert got == float("inf") and math.isinf(got)
    assert not math.isnan(got)


def test_scd_degenerate_scale_is_inf():
    # b is 5 coincident points => RMS radius (scale) == 0 < 1e-8 => SCD undefined => inf
    # (a is non-empty so the empty-cloud guard is not the one that fires here)
    a = _mx64(_grid_cloud())
    b = _mx64(np.tile([1.0, 2.0, 3.0], (5, 1)))
    got = scaled_chamfer_distance(a, b)
    assert got == float("inf") and math.isinf(got)
    assert not math.isnan(got)


# --- float32 / default-stream smoke (§5.3 / D-9 gradient-loop monitoring) ----------------------


def _mx32(values) -> mx.array:
    # float32 on the default (GPU) stream — the precision the U5.2 gradient loop monitors
    return mx.array(np.asarray(values, dtype=np.float32))


def test_losses_float32_finite_nonnegative():
    a = _mx32(_grid_cloud() + np.array([0.02, -0.01, 0.03]))
    b = _mx32(_grid_cloud())
    cd = chamfer_distance(a, b)
    scd = scaled_chamfer_distance(a, b)
    assert math.isfinite(cd) and cd >= 0.0
    assert math.isfinite(scd) and scd >= 0.0


# --- rms/max deviation (pass-through to params.deviation) -------------------------------------

DEG_U = DEG_V = 2
S_U_KNOTS = [0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0]  # len = 4 + 2 + 1
S_V_KNOTS = [0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0]


def _surf_poles() -> np.ndarray:
    p = np.empty((4, 4, 3), dtype=np.float64)
    for i in range(4):
        for j in range(4):
            p[i, j] = (i * 0.5, j * 0.5, 0.3 * math.sin(i) * math.cos(j))
    return p


# fixed strictly-interior (u, v), away from domain edges, off the 32-pt seed lattice
DEV_UV = [(0.20, 0.30), (0.40, 0.60), (0.55, 0.25), (0.70, 0.72), (0.35, 0.80), (0.62, 0.45)]
DEV_U = np.array([u for u, _ in DEV_UV], dtype=np.float64)
DEV_V = np.array([v for _, v in DEV_UV], dtype=np.float64)
OFFSET_DIST = 0.03


def _surf_args() -> tuple:
    return (_mx64(_surf_poles()), None, _mx64(S_U_KNOTS), _mx64(S_V_KNOTS), DEG_U, DEG_V)


def _on_surface_points() -> mx.array:
    return surface_point(*_surf_args(), _mx64(DEV_U), _mx64(DEV_V))


def _offset_points() -> mx.array:
    ders = surface_derivs(*_surf_args(), _mx64(DEV_U), _mx64(DEV_V))
    s, su, sv = np.array(ders.S), np.array(ders.Su), np.array(ders.Sv)
    n = np.cross(su, sv)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return _mx64(s + OFFSET_DIST * n)


def test_rms_max_deviation_on_surface_near_zero():
    rms, mx_dev = rms_max_deviation(_on_surface_points(), *_surf_args())
    assert rms < 1e-7
    assert mx_dev < 1e-7


def test_rms_max_deviation_offset_matches_numpy_offset():
    rms, mx_dev = rms_max_deviation(_offset_points(), *_surf_args())
    assert abs(rms - OFFSET_DIST) < 1e-4
    assert abs(mx_dev - OFFSET_DIST) < 1e-4


def test_rms_max_deviation_agrees_with_params_deviation():
    pts = _offset_points()
    assert rms_max_deviation(pts, *_surf_args()) == deviation(pts, *_surf_args())


def test_rms_max_deviation_deterministic_bitwise():
    pts = _offset_points()
    assert rms_max_deviation(pts, *_surf_args()) == rms_max_deviation(pts, *_surf_args())
