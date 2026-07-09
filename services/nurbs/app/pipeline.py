"""Open-mode mesh→NURBS fitting pipeline (SPEC-12 §5.1, FR-2/FR-3/FR-9).

This is the end-to-end open-mode seam with no mocks — the whole chain a disk-topology
(single-boundary-loop) GLB takes to a single-patch STEP + a fidelity report:

    GLB bytes
      → app.meshio.load_mesh / detect_mode   (decode + topology gate, §5.1 / FR-1)
      → app.param.harmonic_disk_map          (unit-square uv parameterization)
      → app.core.fit_lsq.fit_scattered       (scattered LSQ, FR-2; FLAT knots; the four uv-side
                                              rims pinned to the boundary polyline — FR-3 sew)
      → app.core.params.deviation            (real projection rms/max, FR-9)
      → app.core.losses chamfer/scaled       (fitted-surface-vs-input fidelity, FR-9)
      → §6.2 payload (app.core.knots.flat_to_compact at the schema boundary)
      → app.schema.Surfaces                  (every §6.2 invariant, before OCCT — FR-6)
      → app.occ_step.surfaces_json_to_step   (crash-isolated OCCT → STEP, FR-3)
      → the FR-9 report

Two forms are exported: :func:`fit_open` (typed kwargs — the direct API the tests drive, and what
:func:`app.main._load_pipeline_fit` calls for open-mode jobs) and :func:`fit` (the ``payload: dict``
adapter mirroring the §6.1 wire shape: it base64-decodes the GLB then delegates to :func:`fit_open`,
and is exercised by ``tests/test_pipeline_open.py``). Note ``app.main._load_pipeline_fit`` does NOT
route through :func:`fit`; it base64-decodes and dispatches by detected mode to :func:`fit_open` /
:func:`app.pipeline_closed.fit_closed` DIRECTLY. Both forms carry the NESTED Surfaces object
``{"surfaces": [...]}`` as their ``surfaces`` field (frozen by ``tests/test_api.py`` and the U9 client).

Knot-form discipline (SPEC-12 §6.2): the core computes on FLAT/textbook knot vectors
(``ScatteredFit.u_knots``/``v_knots``) and the deviation metric is measured against *those*.
Only the schema/OCCT payload carries COMPACT knots (unique values + parallel multiplicities),
produced once by :func:`app.core.knots.flat_to_compact`. The flat form is never round-tripped
through compact before the deviation call.

``iters == 0`` (pure LSQ, FR-2) is a complete supported mode. ``iters > 0`` runs the landed
gradient refinement (``core/fit_grad.py``, U5.2): the LSQ init's control points are refined by
``fit_grad.refine`` (Chamfer + fairness), then the all-float32 ``RefinedFit`` is converted back
to float64 for the schema/OCCT parity path below (§5.3; the knots carry the init's values,
refine never optimises them). FR-2's "never worse than the init" is enforced HERE, at the
pipeline level: ``refine`` keeps its best iterate by CHAMFER on its own sampling lattice, but the
report and the FR-5 accuracy gate use the ``params.deviation`` PROJECTION metric — the two
diverge — so ``fit_open`` recomputes that deviation for the init AND the refined fit and reports
whichever does not regress rms/max (best-of-init-or-refined), never worse than the LSQ init on
the metric the report actually carries. Chamfer /
SCD (U5.1 ``core/losses.py``) are real: the report carries the bidirectional squared Chamfer
and the
scaled Chamfer of the fitted surface — sampled on a uv lattice — against the input cloud, and
rms/max come from the real projection deviation. Deterministic throughout (float64 CPU-stream
solves, no RNG — NFR-1): identical GLB bytes give bitwise-equal surfaces and report.
"""

from __future__ import annotations

import base64
import logging
import math

import mlx.core as mx
import numpy as np

from app import meshio, occ_step, param, schema
from app.core import fit_grad, losses
from app.core.eval import surface_point
from app.core.fit_lsq import ScatteredFit, _chol_solve, _design_matrix_1d, fit_scattered
from app.core.knots import clamped_uniform, flat_to_compact
from app.core.params import deviation

__all__ = ["fit", "fit_open"]

logger = logging.getLogger(__name__)

# Worst per-arc rim interpolation residual above which the FR-3 < 1e-6 sewability bound is not
# attainable at the chosen grid (the arc has more boundary vertices than the grid has control
# points). Surfaced via a warning rather than faked/silently loosened (SPEC-12 FR-3 discipline).
_RIM_SEWABLE_TOL = 1e-6

# OCCT runs in a spawned child (crash isolation); cap it so a hung STEP conversion fails the
# job instead of blocking the caller (the throwaway integration probe used the same bound).
_OCC_TIMEOUT_S = 60.0

# The four unit-square corners in counter-clockwise perimeter order, matching
# app.param._SQUARE_CORNERS. harmonic_disk_map writes these EXACTLY at the four quarter-arc
# boundary vertices, so the open patch's single boundary loop is split into four arcs — one per
# uv side (u0/u1/v0/v1) — by locating them via exact uv equality (see :func:`_boundary_rim`).
_SQUARE_UV_CORNERS = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))

# (constant uv coordinate index, its 0.0/1.0 value) ↔ the fit_scattered rim key for that side.
# Coordinate 0 is u, 1 is v: v0/v1 pin a control-net column poles[:, j] (varying u); u0/u1 pin a
# row poles[i, :] (varying v). Every rim key indexes its edge by INCREASING varying coordinate,
# so an arc walked against that direction is reversed (see :func:`_boundary_rim`) — the same
# uv-derived ordering app.boundary.pin_chart_rims applies to the closed-mode shared rims.
_UV_SIDE_KEYS = {
    (1, 0.0): "v0",  # bottom: v == 0, varying coord u
    (0, 1.0): "u1",  # right:  u == 1, varying coord v
    (1, 1.0): "v1",  # top:    v == 1, varying coord u
    (0, 0.0): "u0",  # left:   u == 0, varying coord v
}


def _second_difference(n_ctrl: int) -> np.ndarray:
    """``(n_ctrl-2, n_ctrl)`` second-difference operator (rows ``[1, -2, 1]``).

    ``‖D·P‖²`` is the control polygon's discrete bending energy — the fairness functional the
    rim interpolant minimizes so the pinned boundary is the SMOOTHEST curve through the arc's
    vertices (mirrors :func:`app.boundary._second_difference`; kept local so ``pipeline.py``
    never reaches into another module's private helpers).
    """
    d = np.zeros((n_ctrl - 2, n_ctrl), dtype=np.float64)
    for k in range(n_ctrl - 2):
        d[k, k], d[k, k + 1], d[k, k + 2] = 1.0, -2.0, 1.0
    return d


def _fit_rim_arc(arc_points: np.ndarray, degree: int, n_ctrl: int) -> tuple[np.ndarray, float]:
    """``n_ctrl`` control points on ``clamped_uniform(n_ctrl, degree)`` fitting one boundary arc.

    The arc is chord-length parameterized (identical to the arc-length uv the harmonic map
    assigns this side, so evaluating the pinned surface at a boundary vertex's uv reproduces
    the curve at that vertex). The two end control points are pinned BITWISE to the arc's end
    vertices (clamped ends ⇒ they are the curve endpoints), so adjacent arcs share each corner
    vertex exactly and ``fit_scattered``'s 1e-12 corner-consistency check passes by construction.

    When ``n_ctrl >= len(arc_points)`` the interior is the EXACT minimum-bending interpolant
    (equality-constrained least bending — ``min ‖D·P‖²`` s.t. the curve passes through every arc
    vertex), so the rim reproduces the polyline vertices to solver precision (≪ 1e-6). When the
    arc has MORE vertices than control points (``n_ctrl < len(arc_points)`` — e.g. a coarse
    ``grid`` under a finely tessellated boundary) exact interpolation is impossible; it falls
    back to a fairness-regularized least-squares approximation and returns its (nonzero)
    residual so the caller can surface that the 1e-6 bound is not attainable at that grid.

    Returns ``(control_points (n_ctrl, 3) float64, max_vertex_residual)``.
    """
    pts = np.asarray(arc_points, dtype=np.float64)
    m = pts.shape[0]
    first, last = pts[0], pts[-1]
    knots = np.asarray(clamped_uniform(n_ctrl, degree), dtype=np.float64)
    if n_ctrl == 2:  # only the two pinned endpoints exist (degenerate straight segment)
        return np.stack([first, last]), 0.0

    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    total = float(seg.sum())
    if not (total > 0.0 and np.isfinite(total)):
        raise ValueError("degenerate boundary arc: zero total chord length (coincident vertices)")
    t = np.concatenate([[0.0], np.cumsum(seg)]) / total
    t[-1] = 1.0

    with mx.stream(mx.cpu):
        collocation = _design_matrix_1d(
            mx.array(t, dtype=mx.float64), mx.array(knots, dtype=mx.float64), degree, n_ctrl
        )
    n_all = np.asarray(collocation, dtype=np.float64)  # (m, n_ctrl)
    # Interior data rows only (the two endpoints are pinned); their pinned-endpoint contribution
    # is moved to the RHS (A9.6 Eq. 9.63), so the interior control points fit the residual.
    n_int = n_all[1 : m - 1, 1 : n_ctrl - 1]  # (m-2, n_ctrl-2)
    n0 = n_all[1 : m - 1, 0]
    nlast = n_all[1 : m - 1, n_ctrl - 1]
    residual = pts[1 : m - 1] - np.outer(n0, first) - np.outer(nlast, last)  # (m-2, 3)
    n_interior = n_ctrl - 2
    n_data = m - 2

    if n_data <= 0:  # only the two endpoints (a 2-vertex arc) — interior is a straight run
        d = _second_difference(n_ctrl)
        d_int, d_pin = d[:, 1 : n_ctrl - 1], d[:, [0, n_ctrl - 1]]
        with mx.stream(mx.cpu):
            gram = mx.array(d_int.T @ d_int + 1e-9 * np.eye(n_interior), dtype=mx.float64)
            rhs = mx.array(-(d_int.T @ (d_pin @ np.stack([first, last]))), dtype=mx.float64)
            interior = np.asarray(_chol_solve(gram, rhs), dtype=np.float64)
    elif n_interior >= n_data:
        # EXACT minimum-bending interpolation: min ½‖D_int·P + c‖² s.t. N_int·P = residual.
        # KKT [ D_intᵀD_int  N_intᵀ ; N_int  0 ] [P ; μ] = [ -D_intᵀc ; residual ] (symmetric
        # indefinite ⇒ a dense float64 numpy solve, deterministic; a ridge keeps D_intᵀD_int SPD).
        d = _second_difference(n_ctrl)
        d_int, d_pin = d[:, 1 : n_ctrl - 1], d[:, [0, n_ctrl - 1]]
        c = d_pin @ np.stack([first, last])  # (n_ctrl-2, 3) pinned-endpoint bending contribution
        a = d_int.T @ d_int + 1e-9 * np.eye(n_interior)
        kkt = np.zeros((n_interior + n_data, n_interior + n_data), dtype=np.float64)
        kkt[:n_interior, :n_interior] = a
        kkt[:n_interior, n_interior:] = n_int.T
        kkt[n_interior:, :n_interior] = n_int
        rhs = np.zeros((n_interior + n_data, 3), dtype=np.float64)
        rhs[:n_interior] = -(d_int.T @ c)
        rhs[n_interior:] = residual
        interior = np.linalg.solve(kkt, rhs)[:n_interior]
    else:
        # More arc vertices than control points ⇒ exact interpolation is impossible at this grid;
        # fall back to fairness-regularized LSQ (won't reach 1e-6 — residual returned to caller).
        d = _second_difference(n_ctrl)
        d_int = d[:, 1 : n_ctrl - 1]
        with mx.stream(mx.cpu):
            gram = mx.array(n_int.T @ n_int + 1e-4 * (d_int.T @ d_int), dtype=mx.float64)
            rhs = mx.array(n_int.T @ residual, dtype=mx.float64)
            interior = np.asarray(_chol_solve(gram, rhs), dtype=np.float64)

    control = np.vstack([first, interior, last])
    max_residual = float(np.linalg.norm(n_all @ control - pts, axis=1).max())
    return control, max_residual


def _boundary_rim(
    mesh, uv: np.ndarray, points: np.ndarray, degree: int, grid: int
) -> tuple[dict, float]:
    """Build the ``fit_scattered`` rim dict pinning all four uv sides to the boundary polyline.

    ``harmonic_disk_map`` places the four unit-square corners at the boundary loop's quarter-arc
    vertices, so the loop splits into four arcs — one per uv side. Each arc's 3-D polyline is
    interpolated by :func:`_fit_rim_arc` into ``grid`` control points on the patch's
    ``clamped_uniform`` knots and mapped onto its ``u0``/``u1``/``v0``/``v1`` key (side + order
    derived from the arc's actual uv, exactly as ``app.boundary.pin_chart_rims`` does for the
    closed mode), so ``fit_scattered`` reproduces the boundary along the pinned edges — FR-3.

    Returns ``(rim, max_residual)`` where ``rim`` is the ``{"u0","u1","v0","v1"}`` → ``(grid, 3)``
    dict and ``max_residual`` is the worst per-arc interpolation residual — ``≪ 1e-6`` whenever
    ``grid`` can interpolate every arc, and only larger when ``grid`` is too coarse for a finely
    tessellated arc (the caller uses it to gate rim freezing and to warn, part of the
    surfaced-not-faked contract). Raises ``ValueError`` if the boundary does not resolve to four
    distinct corners/sides (a non-disk boundary — never emit a silently wrong rim).
    """
    loop = np.asarray(meshio.boundary_loops(mesh)[0], dtype=np.int64)
    loop_uv = uv[loop]

    # Locate the four square corners in the loop by exact uv equality (harmonic_disk_map set
    # them exactly); their loop positions partition the cyclic loop into the four side arcs.
    corner_positions = []
    for cu, cv in _SQUARE_UV_CORNERS:
        hits = np.flatnonzero((loop_uv[:, 0] == cu) & (loop_uv[:, 1] == cv))
        if hits.size != 1:
            raise ValueError(
                f"open-mode rim: boundary uv has {hits.size} vertices at square corner "
                f"{(cu, cv)} (need exactly 1) — not a clean disk parameterization"
            )
        corner_positions.append(int(hits[0]))
    ordered = sorted(corner_positions)

    rim: dict[str, np.ndarray] = {}
    max_residual = 0.0
    n_loop = len(loop)
    for k, start in enumerate(ordered):
        stop = ordered[k + 1] if k + 1 < len(ordered) else ordered[0] + n_loop
        arc_positions = [i % n_loop for i in range(start, stop + 1)]  # inclusive of both corners
        arc_uv = loop_uv[arc_positions]
        # Classify the side: the arc's constant uv coordinate (0=u, 1=v) fixed at 0.0/1.0.
        side_key = None
        for coord in (0, 1):
            value = arc_uv[0, coord]
            if value in (0.0, 1.0) and np.all(arc_uv[:, coord] == value):
                side_key = _UV_SIDE_KEYS[(coord, value)]
                varying = 1 - coord
                walk_ascending = bool(arc_uv[0, varying] <= arc_uv[-1, varying])
                break
        if side_key is None:
            raise ValueError(
                "open-mode rim: a boundary arc does not lie on a single uv side "
                f"(uv {arc_uv.tolist()}) — not a clean disk parameterization"
            )
        if side_key in rim:
            raise ValueError(f"open-mode rim: two boundary arcs map to the same uv side {side_key!r}")
        control, resid = _fit_rim_arc(points[loop[arc_positions]], degree, grid)
        max_residual = max(max_residual, resid)
        # Order the control points the way fit_scattered indexes this edge (increasing varying
        # coordinate); reverse when the boundary walk runs against it (descending sides).
        rim[side_key] = control if walk_ascending else control[::-1]

    if set(rim) != {"u0", "u1", "v0", "v1"}:
        raise ValueError(f"open-mode rim: boundary arcs did not cover all four uv sides: {set(rim)}")
    if max_residual > _RIM_SEWABLE_TOL:
        # Surfaced, not faked: a boundary arc has more vertices than grid control points, so the
        # rim can only APPROXIMATE it — the FR-3 < 1e-6 sew bound is unattainable until grid is
        # raised above the arc's vertex count (or the region is faceted, FR-5).
        logger.warning(
            "open-mode rim interpolation residual %.3e m exceeds the FR-3 sewability bound %.0e "
            "at grid=%d — a boundary arc has more vertices than the grid has control points; "
            "the fitted rim only approximates the mesh polyline (raise grid to interpolate)",
            max_residual,
            _RIM_SEWABLE_TOL,
            grid,
        )
    return rim, max_residual


def fit_open(
    glb_bytes: bytes,
    *,
    mode: str = "auto",
    degree: int = 3,
    grid: int = 16,
    iters: int = 0,
    fidelity_tol: float | None = None,
) -> dict:
    """Fit a single NURBS patch to an open (disk-topology) mesh (SPEC-12 §5.1 open mode).

    Args:
        glb_bytes: the raw GLB payload (a single disk-topology region).
        mode: ``"auto"`` (detect) or an explicit ``"open"``/``"closed"``. The resolved mode
            must be ``"open"``; a closed mesh is U7's pipeline and is rejected here.
        degree: B-spline degree in both u and v (schema export bound is 2..8; must be ``>= 2``).
        grid: control points per direction (the ``nu == nv`` control net is ``grid × grid``).
            Default ``16`` — the shared value with the ``/fit`` API and the :func:`fit` adapter
            (SPEC-12 §6.1), so the direct and payload paths fit the same net.
        iters: gradient-refinement iterations. ``0`` ⇒ pure LSQ (FR-2). ``> 0`` refines the LSQ
            init with :func:`app.core.fit_grad.refine`, then keeps whichever of the LSQ init and
            the refined fit is not worse on the ``params.deviation`` projection metric the report
            uses (best-of-init-or-refined ⇒ never worse than the init on the reported metric,
            FR-2; see the inline comment). The four boundary rims are frozen during refinement
            (``freeze=rim``) — but only when the rim actually interpolated its boundary arc
            (``rim_residual < _RIM_SEWABLE_TOL``); a rim too coarse to interpolate (grid < arc
            vertices) has no sewability to protect and is left free — so refinement improves the
            interior without moving an FR-3 sewable boundary.
        fidelity_tol: optional per-patch deviation tolerance; carried through to the report
            (the accuracy gate + faceted fallback is U7.4). Default ``None``.

    Returns:
        ``{"step": <STEP text>, "surfaces": {"surfaces": [<§6.2 dict>]}, "report": <FR-9>}``.

    Raises:
        ValueError: the mesh is not open (disk topology) — closed meshes are U7's pipeline —
            or ``degree < 2`` (below the §6.2 B-spline export bound).
    """
    if degree < 2:
        raise ValueError(
            f"degree must be >= 2 for the §6.2 B-spline export (schema bound is 2..8); got {degree}"
        )
    mesh = meshio.load_mesh(glb_bytes)
    resolved = meshio.detect_mode(mesh, mode)
    if resolved != "open":
        raise ValueError(
            f"fit_open handles open (disk-topology) meshes only, but the mesh resolved to "
            f"{resolved!r} — a closed mesh is U7's closed-mode pipeline, not the open-mode fit"
        )

    # Parameterize the disk onto the unit square, then scattered-LSQ fit the mesh vertices with
    # the four uv-side rims PINNED to the boundary polyline (FR-3): harmonic_disk_map splits the
    # single boundary loop into four quarter-arcs, one per uv side, and _boundary_rim interpolates
    # each into this direction's clamped_uniform control points. fit_scattered reproduces the
    # pinned edges exactly, so the fitted patch passes through the mesh boundary vertices — the
    # coincident-boundary property that lets a faceted/planar neighbour sew with it (U10 delegation).
    uv = param.harmonic_disk_map(mesh)  # (n, 2) float64
    points = np.asarray(mesh.vertices, dtype=np.float64)  # (n, 3)
    rim, rim_residual = _boundary_rim(mesh, uv, points, degree, grid)
    fit = fit_scattered(points, uv, degree, degree, grid, grid, rim=rim)

    # Real projection deviation, measured against the FLAT knot vectors the core solved on (never
    # the compact schema form). points must be an mx float64 array (project_points reads
    # points.dtype); the fit's poles/knots are already mx float64. This is the rms/max the FR-9
    # report and the FR-5 accuracy gate consume, so it is also the metric on which the FR-2
    # "never worse than the init" guarantee is enforced (see best-of-init-or-refined below). At
    # iters == 0 this IS the reported deviation (pure LSQ, FR-2).
    points_mx = mx.array(points, dtype=mx.float64)
    rms, dmax = deviation(points_mx, fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q)

    # FR-2 gradient refinement: iters == 0 keeps the pure-LSQ fit above; iters > 0 refines the
    # LSQ init's control points with core/fit_grad.refine (Chamfer + fairness). refine runs in
    # float32 on the GPU stream (D-9) and returns an all-float32 RefinedFit, but schema.Surfaces
    # + occ_step + params.deviation need float64 (the 1e-9 D0/D1 parity, §5.3), so convert the
    # refined poles AND knots back to float64 before that path. The knots carry the init's values
    # (refine never optimises them), so the f32→f64 widening only restores the type. Freeze the
    # four rim edges through refinement (gradient masking, §5.4) so the interior improves without
    # moving the sewable boundary — but ONLY when the rim actually interpolated (rim_residual <
    # _RIM_SEWABLE_TOL): a rim too coarse to interpolate its boundary arc (grid < arc vertices)
    # has no sewability to protect, so it is left free for refinement to improve the under-fit
    # patch (the coarse-grid FR-2 path).
    #
    # BEST-OF-INIT-OR-REFINED (the honest FR-2 guarantee — batch-14 open-pipeline review High):
    # refine keeps its best iterate by CHAMFER on its own sampling lattice, but the report and the
    # FR-5 accuracy gate use the params.deviation PROJECTION metric — the two DIVERGE, and at the
    # service default (grid=16, iters=200) refine's Chamfer-best iterate is ~72x/26x WORSE on
    # projection rms/max than the pure-LSQ init. So we recompute params.deviation for the refined
    # fit and KEEP it only when it does not regress EITHER projection metric (refined rms <= init
    # rms AND refined max <= init max); otherwise we fall back to the LSQ init. The reported and
    # exported fit is therefore never worse than the init on the metric the report / the gate
    # actually consume. Both the init (fit_scattered's pinned rim) and the refined fit (its frozen
    # rim, when the rim is sewable and thus frozen) keep the rim < 1e-6, so whichever fit is chosen
    # stays sewable (FR-3). Deterministic: the choice is two RNG-free deviation calls.
    freeze = rim if rim_residual < _RIM_SEWABLE_TOL else None
    if iters > 0:
        refined = fit_grad.refine(points, fit, iters=iters, freeze=freeze)
        refined_fit = ScatteredFit(
            poles=mx.array(np.asarray(refined.poles, dtype=np.float64), dtype=mx.float64),
            u_knots=mx.array(np.asarray(refined.u_knots, dtype=np.float64), dtype=mx.float64),
            v_knots=mx.array(np.asarray(refined.v_knots, dtype=np.float64), dtype=mx.float64),
            p=refined.p,
            q=refined.q,
        )
        refined_rms, refined_max = deviation(
            points_mx, refined_fit.poles, None,
            refined_fit.u_knots, refined_fit.v_knots, refined_fit.p, refined_fit.q,
        )
        if refined_rms <= rms and refined_max <= dmax:
            fit, rms, dmax = refined_fit, refined_rms, refined_max

    # Chamfer & SCD (FR-9 fidelity, U5.1 core/losses.py): sample the fitted surface on a
    # ceil(sqrt(M))×ceil(sqrt(M)) uv lattice over the knot domain (~M samples, matching the
    # input cloud's density) and measure both directions against the input cloud. Grid ops are
    # float64, which is CPU-only in MLX (§5.3 / D-9), so the lattice is built on the CPU stream;
    # surface_point and the losses re-enter the CPU stream themselves. a = fitted-surface
    # samples, b = input cloud (SCD normalizes by the input cloud's RMS radius — the GT scale).
    nu, nv = fit.poles.shape[0], fit.poles.shape[1]
    side = max(2, math.ceil(math.sqrt(points.shape[0])))
    with mx.stream(mx.cpu):
        u_lo, u_hi = fit.u_knots[fit.p].item(), fit.u_knots[nu].item()
        v_lo, v_hi = fit.v_knots[fit.q].item(), fit.v_knots[nv].item()
        gu = mx.linspace(u_lo, u_hi, side, dtype=mx.float64)
        gv = mx.linspace(v_lo, v_hi, side, dtype=mx.float64)
        uu = mx.broadcast_to(gu[:, None], (side, side)).reshape(-1)
        vv = mx.broadcast_to(gv[None, :], (side, side)).reshape(-1)
    sampled = surface_point(fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q, uu, vv)
    chamfer = float(losses.chamfer_distance(sampled, points_mx))
    scd = float(losses.scaled_chamfer_distance(sampled, points_mx))

    # §6.2 payload: FLAT → COMPACT knots at the schema boundary; poles → nested lists.
    u_knots_c, u_mults = flat_to_compact(np.asarray(fit.u_knots).tolist())
    v_knots_c, v_mults = flat_to_compact(np.asarray(fit.v_knots).tolist())
    poles_nested = np.asarray(fit.poles, dtype=np.float64).tolist()
    surfaces_payload = {
        "surfaces": [
            {
                "poles": poles_nested,
                "weights": [],  # [] ⇒ non-rational (the scattered fit is non-rational)
                "u_knots": u_knots_c,
                "v_knots": v_knots_c,
                "u_mults": u_mults,
                "v_mults": v_mults,
                "u_degree": fit.p,
                "v_degree": fit.q,
                "u_periodic": False,
                "v_periodic": False,
            }
        ]
    }
    # Validate every §6.2 invariant before OCCT ever sees the data (FR-6); surfaces_json_to_step
    # re-validates in-process (and again in the spawned worker), so a bad payload is a specific
    # ValidationError, never a native crash.
    schema.Surfaces(**surfaces_payload)
    # face_count is OCCT's real face tally of the built shape — exactly 1 for the single open
    # patch. Use it to corroborate patches/is_valid rather than hardcoding: MakeFace of the one
    # fitted B-spline yielding exactly one face is what "valid single open patch" means.
    step_text, face_count = occ_step.surfaces_json_to_step(surfaces_payload, timeout=_OCC_TIMEOUT_S)

    report = {
        "patches": face_count,  # OCCT's real face count — 1 for the single open patch
        "fitted_patches": face_count,  # every patch is NURBS-fitted (none faceted, below)
        "faceted_patches": 0,  # the accuracy gate + faceted fallback is U7.4, not open mode
        "control_points": int(fit.poles.shape[0] * fit.poles.shape[1]),
        "degree_u": fit.p,
        "degree_v": fit.q,
        "iters": iters,
        "chamfer": chamfer,
        "scd": scd,
        "rms_deviation": rms,
        "max_deviation": dmax,
        "fidelity_tol": fidelity_tol,
        "is_solid": False,  # a single open patch is a face, not a closed solid (U7's gate)
        "is_valid": face_count == 1,  # MakeFace produced exactly the one expected open face
        "mode": "open",
    }
    return {"step": step_text, "surfaces": surfaces_payload, "report": report}


def fit(payload: dict) -> dict:
    """``payload: dict`` adapter mirroring the SPEC-12 §6.1 wire shape (exercised by the tests).

    Base64-decodes ``glb_base64`` and forwards the §6.1 fit knobs to :func:`fit_open`. The
    HTTP shell has already applied the §6.1 bounds (pydantic ``FitBody``); this only decodes
    and delegates. Returns the same ``{"step", "surfaces", "report"}`` shape as :func:`fit_open`.
    """
    glb_bytes = base64.b64decode(payload["glb_base64"])
    return fit_open(
        glb_bytes,
        mode=payload.get("mode", "auto"),
        degree=payload.get("degree", 3),
        grid=payload.get("grid", 16),
        iters=payload.get("iters", 0),
        fidelity_tol=payload.get("fidelity_tol"),
    )
