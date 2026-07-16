"""U5.2 — tests for `app/core/fit_grad.py`: differentiable gradient refinement (the MLX headline).

Starting from the deterministic float64 least-squares init of
:func:`app.core.fit_lsq.fit_scattered`, :func:`app.core.fit_grad.refine` optimises the
control points on the **float32 / GPU** stream (the one place D-9 uses f32, SPEC-12 §5.3)
to minimise a bidirectional Chamfer fit term + a control-net Laplacian fairness term
(``mx.value_and_grad`` + ``mx.optimizers.Adam``, ``mx.compile``d step). This is a *real*
M4-Max gradient descent (NFR-2), no stub.

What these tests assert (all deterministic — NO RNG; fixtures are sinusoid-jittered lattices):

  * **THE HEADLINE (NFR-2):** on a noisy sampling of a bumpy analytic dome that a modest
    control net under-fits, ``refine(iters≈250)`` STRICTLY reduces the true Chamfer of the
    fitted surface's grid sampling vs the target cloud, by a real margin, over the LSQ init.
  * ``iters == 0`` ⇒ the init is returned unchanged (bitwise float64 poles).
  * best-iterate-wins: even with a deliberately large learning rate that overshoots, the
    returned Chamfer is never worse than the init's (FR-2).
  * determinism: two identical runs agree to a tight tolerance (NFR-1 — float32 GPU reduction
    order is not bitwise-stable *across MLX versions*, so tolerance, not bitwise).
  * rim-freeze (U7 shared boundaries): a frozen control-net edge is held **bitwise** at its
    float32 init value by gradient masking, while the interior still improves the fit.
  * parameter-correction runs and stays safe (best-iterate protects the ≤-init guarantee).
  * no ``mx.random`` / ``np.random`` anywhere in the source (grep-clean).
"""

import inspect

import mlx.core as mx
import numpy as np
import pytest

import app.core.fit_grad as fg
from app.core.eval import surface_point
from app.core.fit_grad import RefinedFit, refine
from app.core.fit_lsq import fit_scattered
from app.core.losses import chamfer_distance

P = Q = 3


# --- helpers ------------------------------------------------------------------------------------


def _mx32(values) -> mx.array:
    return mx.array(np.asarray(values, dtype=np.float32), dtype=mx.float32)


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input to float32 unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


def _np(a) -> np.ndarray:
    return np.array(a)


def _scatter_uv(k: int) -> np.ndarray:
    """A deterministic irregular ``(k*k, 2)`` set of (u, v) in [0, 1]² — a jittered lattice.

    The jitter is a fixed sinusoid of the lattice indices (NO RNG, FR-6/D-10). The base
    lattice includes 0 and 1 in each direction, so the perimeter is well covered.
    """
    ii, jj = np.meshgrid(np.arange(k), np.arange(k), indexing="ij")
    base_u = ii / (k - 1)
    base_v = jj / (k - 1)
    jitter = 0.35 / (k - 1)
    u = np.clip(base_u + jitter * np.sin(4.0 * ii + 1.3 * jj), 0.0, 1.0)
    v = np.clip(base_v + jitter * np.cos(2.0 * ii + 3.1 * jj), 0.0, 1.0)
    return np.stack([u.reshape(-1), v.reshape(-1)], axis=-1)


def _bumpy_dome_xyz(uv: np.ndarray) -> np.ndarray:
    """A spherical cap with a high-frequency ripple: xy = uv, z = cap + ripple over [0, 1]².

    The ripple ``0.12·sin(6πx)·cos(6πy)`` is deliberately too high-frequency for a modest
    (8×8) control net to reproduce by LSQ, so the LSQ init genuinely under-fits and leaves
    real Chamfer room for the gradient refinement to reduce (NFR-2). Deterministic — no RNG.
    """
    x = uv[:, 0]
    y = uv[:, 1]
    cap = np.sqrt(4.0 - (x - 0.5) ** 2 - (y - 0.5) ** 2)
    ripple = 0.12 * np.sin(6.0 * np.pi * x) * np.cos(6.0 * np.pi * y)
    return np.stack([x, y, cap + ripple], axis=-1)


def _surface_cloud(fit, n: int = 24) -> mx.array:
    """Sample ``fit``'s surface at a uniform ``n × n`` (u, v) lattice — the same grid metric
    :func:`refine` optimises against, evaluated in float32 for both init (f64) and refined (f32)
    so the comparison is apples-to-apples (and avoids the illegal f64-on-GPU knot cast, §5.3)."""
    g = _mx32(np.linspace(0.0, 1.0, n))
    uu = mx.broadcast_to(g[:, None], (n, n)).reshape(-1)
    vv = mx.broadcast_to(g[None, :], (n, n)).reshape(-1)
    poles = _mx32(_np(fit.poles))
    uk = _mx32(_np(fit.u_knots))
    vk = _mx32(_np(fit.v_knots))
    return surface_point(poles, None, uk, vk, fit.p, fit.q, uu, vv)


def _grid_cd(fit, target: mx.array, n: int = 24) -> float:
    """True bidirectional Chamfer of ``fit``'s grid sampling vs the target cloud (eval metric)."""
    return chamfer_distance(_surface_cloud(fit, n), target)


def _init_fit(k: int = 16, nu: int = 8, nv: int = 8, fairness: float = 1e-4):
    """LSQ init from fit_scattered on the bumpy dome (float64) + the float32 target cloud."""
    uv = _scatter_uv(k)
    xyz = _bumpy_dome_xyz(uv)
    init = fit_scattered(_mx64(xyz), _mx64(uv), P, Q, nu, nv, fairness=fairness)
    return init, _mx32(xyz)


# --- THE HEADLINE: real gradient improvement over the LSQ init (NFR-2) --------------------------


def test_refine_strictly_improves_chamfer_over_lsq_init():
    init, target = _init_fit(k=16, nu=8, nv=8, fairness=1e-4)
    init_cd = _grid_cd(init, target)
    refined = refine(target, init, iters=250, fairness=1e-4, learning_rate=1e-2)
    assert isinstance(refined, RefinedFit)
    ref_cd = _grid_cd(refined, target)
    # a REAL margin — gradient descent directly minimises this Chamfer, so it must drop clearly
    assert ref_cd < 0.75 * init_cd, (init_cd, ref_cd)


# --- iters == 0 returns the init unchanged (bitwise float64) ------------------------------------


def test_iters_zero_returns_init_bitwise():
    init, target = _init_fit(k=12)
    out = refine(target, init, iters=0)
    assert isinstance(out, RefinedFit)
    assert out.poles.dtype == mx.float64  # the float64 init, untouched
    assert np.array_equal(_np(out.poles), _np(init.poles))  # bitwise
    assert np.array_equal(_np(out.u_knots), _np(init.u_knots))
    assert np.array_equal(_np(out.v_knots), _np(init.v_knots))
    assert out.p == P and out.q == Q


# --- best-iterate-wins: never worse than the init, even overshooting (FR-2) ---------------------


def test_best_iterate_never_worse_than_init():
    init, target = _init_fit(k=14)
    init_cd = _grid_cd(init, target)
    # a deliberately huge lr overshoots and would transiently worsen the fit; best-iterate
    # tracking must still return a result no worse than the init
    refined = refine(target, init, iters=200, fairness=1e-4, learning_rate=0.5)
    assert _grid_cd(refined, target) <= init_cd + 1e-6, (init_cd, _grid_cd(refined, target))


# --- determinism: two runs agree to a tight tolerance (NFR-1) -----------------------------------


def test_refine_is_deterministic():
    init, target = _init_fit(k=14)
    a = refine(target, init, iters=120, fairness=1e-4, learning_rate=1e-2)
    b = refine(target, init, iters=120, fairness=1e-4, learning_rate=1e-2)
    np.testing.assert_allclose(_np(a.poles), _np(b.poles), rtol=0.0, atol=1e-6)


# --- rim-freeze: a frozen edge is held bitwise while the interior improves (U7) ------------------


def test_rim_freeze_holds_edge_exactly_while_interior_improves():
    init, target = _init_fit(k=16, nu=8, nv=8, fairness=1e-4)
    init_cd = _grid_cd(init, target)
    refined = refine(target, init, iters=250, fairness=1e-4, learning_rate=1e-2, freeze={"u0"})
    # float32 rounding of the init poles on the host — matches refine's CPU-stream f32 cast
    # (round-to-nearest is deterministic); a direct f64.astype(f32) would raise on the GPU (§5.3)
    init_f32 = _np(init.poles).astype(np.float32)
    # the frozen control-net edge (poles[0, :, :]) is held BITWISE at its float32 init value
    # (gradient masking zeroed its update every step) — the U7 shared-boundary property
    assert np.array_equal(_np(refined.poles)[0, :, :], init_f32[0, :, :])
    # ... and the rest of the net still refines the fit
    assert _grid_cd(refined, target) < init_cd, (init_cd, _grid_cd(refined, target))
    # a non-frozen edge DID move (the freeze is targeted, not a global no-op)
    nu_last = refined.poles.shape[0] - 1
    assert not np.array_equal(_np(refined.poles)[nu_last, :, :], init_f32[nu_last, :, :])


# --- parameter correction runs and stays safe ---------------------------------------------------


def test_param_correction_runs_and_is_safe():
    init, target = _init_fit(k=14)
    init_cd = _grid_cd(init, target)
    refined = refine(target, init, iters=150, fairness=1e-4, learning_rate=1e-2,
                     param_correct_every=50)
    assert isinstance(refined, RefinedFit)
    assert _grid_cd(refined, target) <= init_cd + 1e-6, (init_cd, _grid_cd(refined, target))


# --- gradient-target subsample: memory cap + deterministic stride (no RNG) ----------------------


def test_subsample_target_caps_and_is_deterministic():
    # a large synthetic cloud (M >> cap): the gradient-term subsample is bounded by cap and
    # produced by a deterministic stride (no RNG, D-10) — bitwise identical across calls.
    m = 1000
    cap = 64
    target = _mx32(np.stack([np.arange(m), np.arange(m) * 2.0, np.arange(m) * 3.0], axis=-1))
    a = fg._subsample_target(target, cap)
    b = fg._subsample_target(target, cap)
    assert a.shape[0] <= cap, a.shape  # capped
    # deterministic stride == the documented `target[::max(1, M//cap)][:cap]` scheme
    step = max(1, m // cap)
    np.testing.assert_array_equal(_np(a), _np(target)[::step][:cap])
    np.testing.assert_array_equal(_np(a), _np(b))  # bitwise identical (no RNG)
    # M <= cap ⇒ the full cloud passes through untouched (no subsample)
    small = _mx32(np.arange(30 * 3).reshape(30, 3))
    np.testing.assert_array_equal(_np(fg._subsample_target(small, cap)), _np(small))


def test_grad_target_is_capped(monkeypatch):
    # the differentiable Chamfer NEVER sees more than the cap: feed a target far larger than a
    # small monkeypatched cap and record the target size the gradient term actually receives.
    monkeypatch.setattr(fg, "_MAX_GRAD_TARGET", 64)
    seen: list[int] = []
    real_chamfer_sq = fg._chamfer_sq

    def _recording_chamfer_sq(s, target):
        seen.append(int(target.shape[0]))
        return real_chamfer_sq(s, target)

    monkeypatch.setattr(fg, "_chamfer_sq", _recording_chamfer_sq)
    init, target = _init_fit(k=16, nu=8, nv=8, fairness=1e-4)  # M = 256 target points
    assert int(target.shape[0]) > 64  # the full cloud is well over the cap
    refine(target, init, iters=3, fairness=1e-4, learning_rate=1e-2)
    assert seen, "the differentiable Chamfer was never invoked"
    assert max(seen) <= 64, seen  # the gradient term only ever saw the capped subsample


def test_refine_improves_with_subsampled_grad_target(monkeypatch):
    # the subsample path is genuinely ACTIVE here (M=400 target, cap forced to 200 ⇒ stride 2,
    # 200 uniformly-spread points) yet true Chamfer on the FULL cloud still drops by a real
    # margin — the bounded gradient surrogate drives genuine improvement (NFR-2 under the cap).
    monkeypatch.setattr(fg, "_MAX_GRAD_TARGET", 200)
    init, target = _init_fit(k=20, nu=8, nv=8, fairness=1e-4)
    assert int(target.shape[0]) > 200  # M = 400 > cap ⇒ the subsample really engages
    init_cd = _grid_cd(init, target)
    refined = refine(target, init, iters=250, fairness=1e-4, learning_rate=1e-2)
    ref_cd = _grid_cd(refined, target)  # measured on the full cloud (FR-2 metric)
    assert ref_cd < 0.9 * init_cd, (init_cd, ref_cd)


# --- lower-bound validation (matches the iters/fairness/param_correct_every guards) --------------


def test_refine_validates_lower_bounds():
    init, target = _init_fit(k=12)
    with pytest.raises(ValueError):
        refine(target, init, iters=5, learning_rate=0.0)
    with pytest.raises(ValueError):
        refine(target, init, iters=5, learning_rate=-1.0)
    with pytest.raises(ValueError):
        refine(target, init, iters=5, n_grid=1)
    with pytest.raises(ValueError):
        refine(target, init, iters=5, data_weight=-1.0)


# --- n_grid scales with the control net (dense-net callers are not under-sampled) ----------------


def test_n_grid_scales_with_control_net(monkeypatch):
    seen: list[int] = []
    real_grid_params = fg._grid_params

    def _recording_grid_params(n_grid):
        seen.append(int(n_grid))
        return real_grid_params(n_grid)

    monkeypatch.setattr(fg, "_grid_params", _recording_grid_params)
    # a dense 16x16 net: the default sampling lattice auto-scales to max(24, 2*max(nu,nv)) = 32
    init, target = _init_fit(k=20, nu=16, nv=16, fairness=1e-4)
    refine(target, init, iters=1, fairness=1e-4, learning_rate=1e-2)
    assert seen[-1] == max(24, 2 * 16), seen
    # an explicit n_grid is respected verbatim (still validated >= 2)
    seen.clear()
    small_init, small_target = _init_fit(k=12, nu=8, nv=8, fairness=1e-4)
    refine(small_target, small_init, iters=1, n_grid=10, fairness=1e-4, learning_rate=1e-2)
    assert seen[-1] == 10, seen


# --- no RNG (grep-clean) ------------------------------------------------------------------------


def test_no_rng_in_source():
    import app.core.fit_grad as m

    src = inspect.getsource(m)
    assert "mx.random" not in src, "fit_grad must not use mx.random (D-10: no RNG)"
    assert "np.random" not in src, "fit_grad must not use np.random (D-10: no RNG)"
