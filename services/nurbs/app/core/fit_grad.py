"""Differentiable gradient refinement of NURBS control points — SPEC-12 §5.2 `core/fit_grad.py`.

This is the MLX headline (SPEC-12 §5.4-4, NFR-2). Starting from the deterministic float64
least-squares initialisation of :func:`app.core.fit_lsq.fit_scattered`, the control points
are refined by gradient descent to minimise a bidirectional Chamfer fit term plus a
control-net Laplacian fairness term. This is the ONE place the two-precision policy (D-9,
SPEC-12 §5.3) runs on **float32 / the default (GPU) stream** — the LSQ init is float64 on
the CPU stream, and its poles are cast to float32 for the gradient loop.

Method (NURBS-Diff's recipe — arXiv 2104.14547, BSD-3 — reimplemented, minus its random
init per D-10, no RNG):

  * The surface is sampled at a fixed ``n_grid × n_grid`` lattice of ``(u, v)`` via the
    :func:`app.core.eval.design_matrix` ``B`` — built **once**, because the knots and the
    grid are fixed for the whole call, so ``B`` is a constant. The sampled cloud is ``B @ P``
    (the ``B @ P`` evaluation contract of :func:`app.core.eval.design_matrix`). ``n_grid``
    defaults to ``max(24, 2·max(nu, nv))`` — it scales with the control net so a dense net is
    not under-constrained by a coarse sampling lattice (§5.4-5); pass an explicit ``n_grid`` to
    override.
  * Loss ``= chamfer(B @ P, target') + fairness · Σ‖L·P‖²`` where ``L`` is the umbrella
    control-net Laplacian reused from :func:`app.core.fit_lsq._control_net_laplacian` (same
    ``i·nv + j`` flatten order as ``B``'s columns). The Chamfer inside the loss is an INLINE
    differentiable squared bidirectional Chamfer (:func:`_chamfer_sq`) — **not**
    :func:`app.core.losses.chamfer_distance`, which calls ``.item()`` / ``mx.eval`` and so
    cannot carry gradients through ``P``. Its target ``target'`` is a deterministic stride
    subsample of the cloud (:func:`_subsample_target`, capped at :data:`_MAX_GRAD_TARGET`, no
    RNG) so the dense ``(n_grid², Nt, 3)`` distance tensor stays bounded on a large mesh.
    ``losses.chamfer_distance`` is reused only OUTSIDE the gradient path, on the **full** cloud,
    as the true eval metric for best-iterate tracking (below) — so FR-2 is against the real
    metric, unaffected by the surrogate's subsample.
  * ``mx.value_and_grad`` over the ``{"P": P}`` tree + ``mx.optimizers.Adam``; the
    value-and-grad transform is ``mx.compile``d once per call (shapes are fixed ⇒ no
    recompile). One ``mx.eval`` per optimiser step; Adam's update is applied OUTSIDE the
    compiled graph.
  * BEST-ITERATE-WINS (FR-2): the lowest *true* Chamfer (via ``losses.chamfer_distance``)
    seen across all iterations is tracked, seeded with the init's own Chamfer, and its
    control points are returned — so the result is **never worse than the init**.

Dtype contract (D-9, named explicitly):
  * ``iters == 0`` ⇒ the returned :class:`RefinedFit` carries the init's **float64** poles
    AND float64 knots, bitwise-unchanged (the short-circuit runs before any cast).
  * ``iters > 0`` ⇒ the gradient loop runs in **float32**; the returned :class:`RefinedFit`
    is all-float32 (poles + knots) so it samples on the GPU stream without an illegal float64
    knot cast (``float64.astype(float32)`` raises on the Metal stream, §5.3). Only the control
    points move — the knots carry the init's values (rounded to f32), never optimised
    (SPEC-12 §5.4-5 refines capacity via the grid, never the knots).

Seam caveat (closed-mode / U7.2): because ``iters > 0`` rounds the knots to float32 while
``iters == 0`` keeps them float64, a **refined** patch's knots differ from an **unrefined**
neighbour's by the f32 round-off (~1e-7) even for the same nominal knot vector. That drift is
below the 1e-6 sew tolerance, so a single mixed seam still sews; but to be safe a shared seam
should be treated uniformly — **refine both sides of a seam or neither** — so both sides carry
byte-identical (equally-rounded) knots.

Rim freeze (U7 shared boundaries): pass ``freeze`` — an iterable of edge names among
``{"u0", "u1", "v0", "v1"}`` (or a ``rim`` dict, whose keys are used, so a ``fit_scattered``
``rim`` spec passes straight through) — to hold those control-net boundary rows fixed. The
mechanism is **gradient masking**: each step multiplies the gradient by a 0/1 mask that
zeroes the pinned rows, so Adam (whose update is ``lr·m̂/(√v̂+ε)`` — identically 0 for an
always-zero gradient) never moves them; they stay **bitwise** equal to their float32 init
value. This keeps a patch's rim exactly on a shared fitted curve while its interior refines
(SPEC-7 D-3 watertight-by-construction; U7.2 pins the same edge on adjacent patches).

Parameter correction (optional, default OFF — ``param_correct_every == 0``): every
``param_correct_every`` iterations the target points are re-projected onto the current
surface (:func:`app.core.params.project_points`) and a point-to-surface data term is
refreshed against the corrected parameters. It is off by default; when on, the step runs
uncompiled (the data design matrix changes each round) and best-iterate still protects the
≤-init guarantee.

Deterministic (NFR-1): no RNG anywhere (LSQ init, not random init; fixed iteration budget;
fixed traversal + fixed sampling grid). Float32 GPU reduction order is not bitwise-stable
*across MLX versions* (SPEC-12 NFR-1), so callers should assert determinism to a tight
tolerance, not bitwise.
"""

from typing import NamedTuple

import mlx.core as mx
import mlx.optimizers as optim
import numpy as np

from .eval import design_matrix
from .fit_lsq import ScatteredFit, _control_net_laplacian
from .losses import chamfer_distance
from .params import project_points

__all__ = ["RefinedFit", "refine"]

# the four control-net boundary lines a ``freeze`` spec may pin (mirrors fit_lsq._RIM_EDGES)
_RIM_EDGES = ("u0", "u1", "v0", "v1")

# Cap on the number of target points fed to the *differentiable* Chamfer gradient term
# (:func:`_chamfer_sq`). That surrogate materialises a dense ``(n_grid², M, 3)`` distance
# tensor — at the full mesh vertex count (M ~ 200k) it is a multi-GB memory cliff. For the
# GRADIENT descent direction only, the target is deterministically stride-subsampled to at most
# this many points (:func:`_subsample_target`, no RNG per D-10). The best-iterate/FR-2 metric
# still evaluates the TRUE Chamfer (:func:`app.core.losses.chamfer_distance`) on the FULL cloud,
# so the never-worse-than-init guarantee is unaffected by the surrogate's subsample.
_MAX_GRAD_TARGET = 4096


class RefinedFit(NamedTuple):
    """A gradient-refined non-rational B-spline surface — mirrors :class:`app.core.fit_lsq.ScatteredFit`.

    Drops straight into :func:`app.core.eval.surface_point`
    (``surface_point(fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q, u, v)``).
    All fields are **float32** for ``iters > 0`` and **float64** (the init, bitwise-unchanged)
    for ``iters == 0`` — the struct is dtype-consistent either way so it samples on the right
    stream. The knots always carry the init's values (only the control points move).
    """

    poles: mx.array
    """Control net, shape ``(nu, nv, 3)`` — float32 (``iters > 0``) or float64 (``iters == 0``)."""
    u_knots: mx.array
    """Flat clamped u knot vector, length ``nu + p + 1`` — same dtype as ``poles``."""
    v_knots: mx.array
    """Flat clamped v knot vector, length ``nv + q + 1`` — same dtype as ``poles``."""
    p: int
    """Degree in u."""
    q: int
    """Degree in v."""


def _to_f32(x) -> mx.array:
    """Coerce array-like to a float32 ``mx.array`` (the gradient-loop dtype, D-9).

    A float64 ``mx.array`` is cast on the CPU stream: ``float64.astype(float32)`` on the
    default (GPU) stream raises "float64 is not supported on the GPU" (§5.3), since the
    float64 operand cannot be placed on Metal even to be down-cast.
    """
    if isinstance(x, mx.array):
        if x.dtype == mx.float32:
            return x
        with mx.stream(mx.cpu):
            return x.astype(mx.float32)
    return mx.array(np.asarray(x, dtype=np.float32), dtype=mx.float32)


def _edge_indices(edge: str, nu: int, nv: int) -> list[int]:
    """The flattened ``i·nv + j`` control-net indices of one boundary line (``B``'s column order)."""
    if edge == "u0":
        return [0 * nv + j for j in range(nv)]
    if edge == "u1":
        return [(nu - 1) * nv + j for j in range(nv)]
    if edge == "v0":
        return [i * nv + 0 for i in range(nu)]
    if edge == "v1":
        return [i * nv + (nv - 1) for i in range(nu)]
    raise ValueError(f"freeze edge must be one of {_RIM_EDGES} (got {edge!r})")


def _free_mask(freeze, nu: int, nv: int) -> mx.array | None:
    """``(nu*nv, 1)`` float32 mask — 0 on frozen control-net rows, 1 elsewhere; ``None`` if empty.

    ``freeze`` is an iterable of edge names, or a dict whose keys are edge names (so a
    :func:`app.core.fit_lsq.fit_scattered` ``rim`` dict passes through directly). Multiplying
    each step's gradient by this mask zeroes the frozen rows so Adam never moves them
    (gradient masking — see the module docstring). Built host-side in numpy (small,
    deterministic index bookkeeping), returned as a broadcastable ``(n, 1)`` float32 array.
    """
    if freeze is None:
        return None
    edges = list(freeze.keys() if isinstance(freeze, dict) else freeze)
    if not edges:
        return None
    pinned: set[int] = set()
    for edge in edges:
        pinned.update(_edge_indices(edge, nu, nv))
    mask = np.ones((nu * nv, 1), dtype=np.float32)
    for idx in pinned:
        mask[idx, 0] = 0.0
    return mx.array(mask, dtype=mx.float32)


def _grid_params(n_grid: int) -> tuple[mx.array, mx.array]:
    """Flattened float32 ``(uu, vv)`` of a fixed uniform ``n_grid × n_grid`` lattice over [0,1]²."""
    g = mx.linspace(0.0, 1.0, n_grid, dtype=mx.float32)
    uu = mx.broadcast_to(g[:, None], (n_grid, n_grid)).reshape(-1)
    vv = mx.broadcast_to(g[None, :], (n_grid, n_grid)).reshape(-1)
    return uu, vv


def _subsample_target(target: mx.array, cap: int) -> mx.array:
    """Deterministically stride-subsample ``target`` (M, 3) to at most ``cap`` rows — no RNG (D-10).

    Bounds the memory of the differentiable Chamfer's dense ``(n_grid², M, 3)`` tensor
    (:func:`_chamfer_sq`, :data:`_MAX_GRAD_TARGET`). The stride is ``max(1, M // cap)`` so the
    kept rows are evenly spread across the cloud, and the ``[:cap]`` clamp guarantees ``≤ cap``
    rows. When ``M <= cap`` the stride is 1 and the full cloud passes through unchanged. Pure
    index arithmetic on the sample count (deterministic; no seed), matching D-10.
    """
    m = int(target.shape[0])
    step = max(1, m // cap)
    return target[::step][:cap]


def _chamfer_sq(s: mx.array, target: mx.array) -> mx.array:
    """Inline differentiable bidirectional **squared** Chamfer (StepForge Eq. 1) — no host sync.

    ``mean_s min_t ‖s-t‖² + mean_t min_s ‖s-t‖²``. Unlike
    :func:`app.core.losses.chamfer_distance` (which calls ``.item()`` / ``mx.eval`` per block
    and is the eval metric), this returns an ``mx.array`` and carries gradients through ``s``
    — it is the term the optimiser differentiates. The full ``(Ns, Nt)`` distance matrix is
    materialised; NO chunking, because a chunked ``mx.eval`` would break the autodiff graph.
    ``target`` here is the **stride-subsampled** gradient cloud (:func:`_subsample_target`,
    bounded by :data:`_MAX_GRAD_TARGET`), so ``Nt`` is capped — the tensor no longer grows
    without bound with the mesh vertex count (the memory cliff that motivated the cap). Its
    OTHER axis, ``Ns = n_grid²``, scales with the control net (``refine``'s ``n_grid`` default
    ``max(24, 2·max(nu, nv))``), so total footprint is ``O(n_grid²·Nt)`` — bounded by two
    design parameters, negligible for realistic nets. The true-Chamfer FR-2 metric still runs
    on the full cloud outside.
    """
    d2 = mx.sum((s[:, None, :] - target[None, :, :]) ** 2, axis=-1)  # (Ns, Nt)
    return mx.mean(mx.min(d2, axis=1)) + mx.mean(mx.min(d2, axis=0))


def refine(
    points,
    init_fit: ScatteredFit,
    *,
    iters: int = 200,
    fairness: float = 1e-3,
    learning_rate: float = 1e-2,
    n_grid: int | None = None,
    freeze=None,
    param_correct_every: int = 0,
    data_weight: float = 1.0,
) -> RefinedFit:
    """Gradient-refine the control points of an LSQ init to fit ``points`` (SPEC-12 §5.4-4).

    Minimises ``chamfer(B @ P, points) + fairness·Σ‖L·P‖²`` over the control points ``P`` by
    Adam on ``mx.value_and_grad`` (float32 / GPU stream, D-9), keeping the best iterate by
    true Chamfer (FR-2 — never worse than the init). ``iters == 0`` returns the init
    unchanged (its float64 poles, bitwise). See the module docstring for the full method, the
    dtype contract, the rim-freeze mechanism, and the optional parameter-correction round.

    Args:
        points: the target point cloud to fit, shape ``(M, 3)`` (the mesh samples). Cast to
            float32 for the gradient loop.
        init_fit: the LSQ initialisation to refine — a :class:`app.core.fit_lsq.ScatteredFit`
            (or any object exposing ``poles (nu, nv, 3)``, ``u_knots``, ``v_knots``, ``p``,
            ``q``); its float64 poles seed the loop.
        iters: number of Adam steps (``>= 0``; ``0`` ⇒ return the init unchanged).
        fairness: the ``λ`` weight on the control-net Laplacian energy ``Σ‖L·P‖²`` (``>= 0``).
        learning_rate: Adam learning rate.
        n_grid: resolution per direction of the surface-sampling lattice (``B`` is
            ``(n_grid², nu*nv)``). ``None`` (default) auto-scales to ``max(24, 2·max(nu, nv))``
            so a dense control net is not under-sampled; pass an explicit value (``>= 2``) to
            override. The differentiable Chamfer's target is separately capped at
            :data:`_MAX_GRAD_TARGET` (:func:`_subsample_target`), independent of ``n_grid``.
        freeze: optional edge names (or a ``rim`` dict) whose control-net rows stay fixed by
            gradient masking (see the module docstring) — used for U7 shared boundaries.
        param_correct_every: if ``> 0``, re-project the target onto the current surface and
            refresh a point-to-surface data term every this-many iterations (optional; the
            step runs uncompiled while active). ``0`` (default) disables parameter correction.
        data_weight: weight of the parameter-correction data term (ignored when
            ``param_correct_every == 0``).

    Returns:
        :class:`RefinedFit` ``(poles, u_knots, v_knots, p, q)`` — the best-iterate surface.

    Raises:
        ValueError: negative ``iters``, ``fairness``, ``param_correct_every``, or
            ``data_weight``; non-positive ``learning_rate``; ``n_grid < 2``; or an unknown
            ``freeze`` edge name.
    """
    p, q = init_fit.p, init_fit.q
    nu, nv = int(init_fit.poles.shape[0]), int(init_fit.poles.shape[1])

    # Resolve the sampling-lattice resolution BEFORE validating it: ``None`` (default) auto-scales
    # to the control net so a dense net is not under-sampled by a fixed 24×24 lattice (a coarse
    # grid under-constrains a fine net — SPEC-12 §5.4-5). An explicit ``n_grid`` is respected.
    if n_grid is None:
        n_grid = max(24, 2 * max(nu, nv))

    if iters < 0:
        raise ValueError(f"iters must be >= 0 (got {iters})")
    if fairness < 0.0:
        raise ValueError(f"fairness (λ) must be >= 0 (got {fairness})")
    if param_correct_every < 0:
        raise ValueError(f"param_correct_every must be >= 0 (got {param_correct_every})")
    if learning_rate <= 0.0:
        raise ValueError(f"learning_rate must be > 0 (got {learning_rate})")
    if n_grid < 2:
        raise ValueError(f"n_grid must be >= 2 (got {n_grid})")
    if data_weight < 0.0:
        raise ValueError(f"data_weight must be >= 0 (got {data_weight})")

    # iters == 0: return the init untouched (float64 poles, bitwise) — before any f32 cast.
    if iters == 0:
        return RefinedFit(
            poles=init_fit.poles,
            u_knots=init_fit.u_knots,
            v_knots=init_fit.v_knots,
            p=p,
            q=q,
        )

    # --- set up the fixed float32 constants of the gradient loop (D-9: f32 / GPU stream) -------
    # (f64 -> f32 casts go through _to_f32's CPU stream — f64 astype is illegal on the GPU.)
    target = _to_f32(points)  # (M, 3) — the FULL cloud (true-Chamfer FR-2 metric, below)
    # The differentiable Chamfer gradient term runs on a bounded, deterministically stride-
    # subsampled cloud so its dense (n_grid², Nt, 3) tensor never blows up on a large mesh
    # (:data:`_MAX_GRAD_TARGET`, D-10). best_cd / cd_now still use the FULL `target` (FR-2).
    grad_target = _subsample_target(target, _MAX_GRAD_TARGET)
    uk = _to_f32(init_fit.u_knots)
    vk = _to_f32(init_fit.v_knots)
    p0 = _to_f32(init_fit.poles).reshape(nu * nv, 3)  # (n, 3) — B's column order
    lap = _to_f32(_control_net_laplacian(nu, nv))  # (n, n) umbrella Laplacian (fairness)
    uu, vv = _grid_params(n_grid)
    b = design_matrix(uu, vv, uk, vk, p, q, nu, nv)  # (n_grid², n) — the fixed sampling matrix
    free_mask = _free_mask(freeze, nu, nv)
    mx.eval(target, grad_target, uk, vk, p0, lap, b)  # materialise the constants once (deterministic)

    def _make_value_and_grad(data_b: mx.array | None):
        """Build ``value_and_grad`` for the loss; ``data_b`` adds the parameter-correction term."""

        def loss_fn(params: dict) -> mx.array:
            pp = params["P"]
            s = b @ pp  # (n_grid², 3) — the sampled surface cloud
            loss = _chamfer_sq(s, grad_target)  # gradient surrogate on the bounded subsample
            lp = lap @ pp  # (n, 3) — control-net Laplacian
            loss = loss + fairness * mx.sum(lp * lp)
            if data_b is not None:  # parameter-correction point-to-surface data term
                r = data_b @ pp - target
                loss = loss + data_weight * mx.mean(mx.sum(r * r, axis=-1))
            return loss

        return mx.value_and_grad(loss_fn)

    value_and_grad = _make_value_and_grad(None)
    # compile the pure value-and-grad (Adam applied outside); the parameter-correction path
    # rebuilds data_b each round, so it runs uncompiled.
    step_fn = value_and_grad if param_correct_every > 0 else mx.compile(value_and_grad)

    opt = optim.Adam(learning_rate=learning_rate)
    params = {"P": p0}

    # best-iterate-wins, seeded with the init's own true Chamfer (eval metric, outside the
    # gradient path) — the returned surface is never worse than the init (FR-2).
    best_cd = chamfer_distance(b @ p0, target)
    best_p = p0

    for it in range(iters):
        if param_correct_every > 0 and it > 0 and it % param_correct_every == 0:
            # Newton parameter correction: re-project the target onto the current surface and
            # refresh the point-to-surface data term against the corrected parameters.
            proj = project_points(target, params["P"].reshape(nu, nv, 3), None, uk, vk, p, q)
            data_b = design_matrix(proj.uv[:, 0], proj.uv[:, 1], uk, vk, p, q, nu, nv)
            mx.eval(data_b)
            step_fn = _make_value_and_grad(data_b)  # uncompiled (data_b changes each round)

        _loss, grads = step_fn(params)
        if free_mask is not None:  # gradient masking holds the frozen rows fixed
            grads = {"P": grads["P"] * free_mask}
        params = opt.apply_gradients(grads, params)
        s = b @ params["P"]
        mx.eval(params, opt.state, s)  # single eval per step (materialise params + sampled cloud)

        cd_now = chamfer_distance(s, target)  # true Chamfer eval metric (host sync)
        if cd_now < best_cd:
            best_cd = cd_now
            best_p = params["P"]

    mx.eval(best_p)
    # iters > 0: return an all-float32 RefinedFit (poles + the fixed knots, values unchanged)
    # so it samples on the GPU stream without an illegal float64 knot cast (§5.3). Only the
    # control points moved; the knots carry the init's values (rounded to f32), never optimised.
    return RefinedFit(
        poles=best_p.reshape(nu, nv, 3),
        u_knots=uk,
        v_knots=vk,
        p=p,
        q=q,
    )
