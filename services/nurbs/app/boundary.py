"""Shared boundary-curve fitting — the watertight-by-construction lever (SPEC-12 FR-4, R-1).

Closed mode (U7.1) partitions a closed genus-0 mesh into 6 cube-map charts that share
boundary polylines, each polyline stored ONCE and referenced by both incident charts
(:class:`app.param.SharedPolyline`). This module turns that shared topology into shared
*geometry*:

  * :func:`fit_boundary_curve` — fit one ordered 3-D polyline to a 1-D clamped B-spline
    curve (A9.6 endpoint-interpolating least squares) on **data-independent**
    ``clamped_uniform`` knots, so every patch that shares an edge fits it in the identical
    spline space. A small second-difference *fairness* term makes the reduced interior
    system symmetric-positive-definite for ANY sample count — including a **2-vertex**
    (single mesh edge) polyline, which the blob and every cube edge carry and which a bare
    A9.6 solve (zero interior data rows ⇒ singular normal matrix) cannot handle. This is
    exactly the regularization rationale :func:`app.core.fit_lsq.fit_scattered` documents.
  * :func:`fit_shared_curves` — fit EACH shared polyline once into a
    ``polyline_index → (control_points, knots)`` table.
  * :func:`pin_chart_rims` — map a chart's four boundary polylines (each, after U7.1-rev,
    exactly one full uv side) onto the four :func:`app.core.fit_lsq.fit_scattered` rim keys
    (``u0``/``u1``/``v0``/``v1``), reading the shared curve's control points as the pinned
    rim values (side + control-point order derived from the actual uv, not positionally).

Both incident patches pull the SAME table entry, so their shared rim is identical. Because
the ends are clamped, ``fit_scattered`` reproduces exactly the pinned control polygon along
that edge (``S(u, 0) = Σ Nᵢ(u)·poles[:, 0]``), and because ``clamped_uniform`` is
reflection-symmetric (interior knot ``i/spans`` ↔ ``(spans−i)/spans``) the reversed control
polygon the opposite-winding neighbour uses is the geometrically identical edge curve. The
two patches therefore coincide along the shared edge to solver precision — watertight **by
construction**, not by sew tolerance (SPEC-7 D-3's sagitta lesson).

Numerics follow the service policy (SPEC-12 §5.3 / D-9): float64 on the CPU stream, no RNG,
fixed traversal order — identical inputs give bitwise-identical control points. This module
IMPORTS the 1-D building blocks from :mod:`app.core.fit_lsq` (``_design_matrix_1d``,
``_chol_solve``) and never re-derives them.
"""

from __future__ import annotations

import numpy as np

from .core.basis import _stream_for
from .core.fit_lsq import _chol_solve, _design_matrix_1d
from .core.knots import clamped_uniform

import mlx.core as mx  # noqa: E402  (kept below the f64-policy imports it depends on)

__all__ = ["fit_boundary_curve", "fit_shared_curves", "pin_chart_rims"]

# uv side key ↔ (constant coordinate index, constant value). Coordinate 0 is u, 1 is v.
# "u0"/"u1" pin poles[0, :] / poles[nu-1, :] (a control-net row, varies in v);
# "v0"/"v1" pin poles[:, 0] / poles[:, nv-1] (a control-net column, varies in u).
_SIDES = {
    "u0": (0, 0.0),
    "u1": (0, 1.0),
    "v0": (1, 0.0),
    "v1": (1, 1.0),
}

# Whether the CCW boundary walk traverses a side in its INCREASING varying-coordinate
# direction: bottom (v0) walks u 0→1 and right (u1) walks v 0→1 (ascending); top (v1) walks
# u 1→0 and left (u0) walks v 1→0 (descending). Used to cross-check the uv-derived rim order
# against the polyline ref's topological ``reversed`` flag.
_SIDE_WALK_ASCENDING = {"v0": True, "u1": True, "v1": False, "u0": False}


def _chord_params(points: np.ndarray) -> np.ndarray:
    """Normalized cumulative chord-length parameters in [0, 1], endpoints exactly 0 and 1.

    Raises ``ValueError`` on a zero-length (degenerate) polyline — the FR-6 "never a silent
    NaN" contract the rest of the service enforces for degenerate point sequences.
    """
    segments = np.linalg.norm(np.diff(points, axis=0), axis=1)
    total = float(segments.sum())
    if not (total > 0.0 and np.isfinite(total)):
        raise ValueError("degenerate polyline: zero total chord length (coincident points)")
    cumulative = np.concatenate([[0.0], np.cumsum(segments)])
    params = cumulative / cumulative[-1]
    params[-1] = 1.0  # exact endpoint (guard the last division)
    return params


def _second_difference(n_ctrl: int) -> np.ndarray:
    """``(n_ctrl-2, n_ctrl)`` second-difference operator ``D`` — rows ``[1, -2, 1]``.

    ``‖D·P‖²`` is the discrete bending energy of the control polygon. Its null space is the
    linear functions, so with both endpoints pinned the interior block ``Dᵢₙₜᵀ Dᵢₙₜ`` is
    positive definite (a linear polygon zero at both ends is identically zero) — that is what
    keeps :func:`fit_boundary_curve` solvable for any sample count.
    """
    d = np.zeros((n_ctrl - 2, n_ctrl), dtype=np.float64)
    for k in range(n_ctrl - 2):
        d[k, k] = 1.0
        d[k, k + 1] = -2.0
        d[k, k + 2] = 1.0
    return d


def fit_boundary_curve(points, degree: int, n_ctrl: int, *, fairness: float = 1e-4):
    """Fit an ordered 3-D polyline to a 1-D clamped B-spline curve (A9.6 + fairness).

    Chord-length parameters, **data-independent** ``clamped_uniform(n_ctrl, degree)`` knots
    (so every patch sharing this edge fits it in the identical spline space), the two end
    control points interpolated exactly, and the interior control points from the
    fairness-regularized reduced normal equations
    ``(Nᵢₙₜᵀ Nᵢₙₜ + λ·Dᵢₙₜᵀ Dᵢₙₜ) Pᵢₙₜ = Nᵢₙₜᵀ R − λ·Dᵢₙₜᵀ (D_pin·P_pin)`` solved with the
    reused :func:`app.core.fit_lsq._chol_solve`. The fairness term ``λ·DᵀD`` (``D`` the
    second-difference operator) keeps the system SPD for ANY sample count — a bare A9.6 solve
    on a 2-vertex polyline has zero interior data rows and a singular normal matrix; with
    fairness it yields the geometrically exact straight segment (collinear control points).

    Args:
        points: ordered polyline vertices, shape ``(N, 3)`` (``N >= 2``).
        degree: spline degree (``>= 1``).
        n_ctrl: number of control points (``>= degree + 1``).
        fairness: the ``λ`` second-difference weight (``> 0`` — required for the SPD
            guarantee independent of the sample distribution). Small so a dense polyline is
            reproduced faithfully; any positive value handles the degenerate 2-vertex case.

    Returns:
        ``(control_points, knots)`` — ``control_points`` a float64 ``mx.array`` of shape
        ``(n_ctrl, 3)``, ``knots`` the flat ``clamped_uniform(n_ctrl, degree)`` vector as a
        float64 ``np.ndarray`` (length ``n_ctrl + degree + 1``).

    Raises:
        ValueError: bad shape, ``n_ctrl < degree + 1``, non-positive ``fairness``, or a
            degenerate (zero-length) polyline.
    """
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[-1] != 3:
        raise ValueError(f"points must be (N, 3) (got shape {pts.shape})")
    if pts.shape[0] < 2:
        raise ValueError(f"boundary polyline needs at least 2 points (got {pts.shape[0]})")
    if degree < 1:
        raise ValueError(f"degree must be >= 1 (got {degree})")
    if n_ctrl < degree + 1:
        raise ValueError(f"n_ctrl must be >= degree + 1 = {degree + 1} (got {n_ctrl})")
    if fairness <= 0.0:
        raise ValueError(f"fairness (λ) must be > 0 (got {fairness})")

    knots = np.asarray(clamped_uniform(n_ctrl, degree), dtype=np.float64)
    first, last = pts[0], pts[-1]
    if n_ctrl == 2:  # only the two pinned endpoints exist (Bezier-degenerate line)
        return mx.array(np.stack([first, last]), dtype=mx.float64), knots

    params = _chord_params(pts)
    with _stream_for(mx.float64):
        params_mx = mx.array(params, dtype=mx.float64)
        knots_mx = mx.array(knots, dtype=mx.float64)
        collocation = _design_matrix_1d(params_mx, knots_mx, degree, n_ctrl)  # (N, n_ctrl)
        # Endpoint contributions moved to the RHS (A9.6 Eq. 9.63); the clamped-end rows
        # (t=0/t=1) contribute ~0 to the interior columns, so all N rows can be used.
        n0 = collocation[:, 0]  # (N,)
        nlast = collocation[:, n_ctrl - 1]  # (N,)
        interior_cols = collocation[:, 1 : n_ctrl - 1]  # (N, n_ctrl-2)
        data = mx.array(pts, dtype=mx.float64)
        residual = data - n0[:, None] * data[0] - nlast[:, None] * data[-1]
        gram = interior_cols.T @ interior_cols  # (n_ctrl-2, n_ctrl-2), PSD
        rhs = interior_cols.T @ residual  # (n_ctrl-2, 3)

        d = _second_difference(n_ctrl)
        d_int = mx.array(d[:, 1 : n_ctrl - 1], dtype=mx.float64)  # (n_ctrl-2, n_ctrl-2)
        d_pin = mx.array(d[:, [0, n_ctrl - 1]], dtype=mx.float64)  # (n_ctrl-2, 2)
        pinned = mx.stack([data[0], data[-1]], axis=0)  # (2, 3)

        normal = gram + fairness * (d_int.T @ d_int)  # SPD for λ > 0
        rhs = rhs - fairness * (d_int.T @ (d_pin @ pinned))
        interior = _chol_solve(normal, rhs)  # (n_ctrl-2, 3)

        control = mx.concatenate([data[0][None], interior, data[-1][None]], axis=0)
        mx.eval(control)  # force the lazy graph once (deterministic result)
    return control, knots


def fit_shared_curves(charts, mesh_vertices, degree: int, n_ctrl: int, *, fairness: float = 1e-4):
    """Fit every shared polyline ONCE — the ``polyline_index → (poles, knots)`` table.

    One fitted curve per shared edge (:class:`app.param.SharedPolyline`); both incident
    charts later pin their rims to the SAME entry (:func:`pin_chart_rims`), which is what
    makes the seam watertight by construction (R-1).

    Args:
        charts: the :class:`app.param.CubeMapCharts` from :func:`app.param.cube_map_charts`.
        mesh_vertices: the mesh's ``(V, 3)`` vertex array (global indices — the polylines
            store global vertex ids).
        degree: shared spline degree (same for every chart, per the uniform-grid FR-4).
        n_ctrl: shared control-point count per direction (the uniform ``(n, n)`` grid size).
        fairness: passed through to :func:`fit_boundary_curve`.

    Returns:
        ``dict[int, tuple[mx.array, np.ndarray]]`` mapping each polyline index in
        ``charts.polylines`` to its ``(control_points (n_ctrl, 3), knots)``.
    """
    vertices = np.asarray(mesh_vertices, dtype=np.float64)
    table: dict[int, tuple[mx.array, np.ndarray]] = {}
    for index, polyline in enumerate(charts.polylines):
        polyline_points = vertices[np.asarray(polyline.vertices, dtype=np.int64)]
        table[index] = fit_boundary_curve(polyline_points, degree, n_ctrl, fairness=fairness)
    return table


def _classify_uv_side(uvs: np.ndarray) -> tuple[str, bool]:
    """Return the ``(side_key, ascending)`` a chart-boundary polyline lands on.

    All of a shared polyline's uv coordinates share one constant coordinate exactly
    (0.0 or 1.0 — U7.1-rev pins each polyline onto one full uv side). ``ascending`` is
    whether the polyline's vertices run in increasing *varying* coordinate, i.e. whether the
    fitted control points (ordered along the polyline, endpoints interpolated) are already
    ordered the way the ``fit_scattered`` rim expects (``poles[:, 0]`` indexed by increasing
    u, ``poles[0, :]`` by increasing v). Raises ``ValueError`` if the points do not all lie
    on exactly one side.
    """
    points = np.asarray(uvs, dtype=np.float64)
    for key, (const_coord, const_value) in _SIDES.items():
        if np.all(points[:, const_coord] == const_value):
            varying = 1 - const_coord
            ascending = bool(points[0, varying] <= points[-1, varying])
            return key, ascending
    raise ValueError(
        f"polyline uv does not lie on a single uv side (u∈{{0,1}} or v∈{{0,1}}): {points.tolist()}"
    )


def pin_chart_rims(chart, shared_curve_table, charts, degree: int, n_ctrl: int) -> dict:
    """Build the ``rim`` dict for :func:`app.core.fit_lsq.fit_scattered` from shared curves.

    Each of the chart's four boundary polyline refs is (after U7.1-rev) exactly one full uv
    side; this maps each ref onto its ``u0``/``u1``/``v0``/``v1`` key (derived from the
    polyline's actual uv, not positionally) with the shared curve's control points as the
    pinned values — reversed when the polyline runs against the side's increasing parameter,
    so every rim is ordered the way ``fit_scattered`` indexes that edge. Both incident charts
    read the SAME ``shared_curve_table`` entry, so their shared rim is identical → watertight.

    The shared curve's knots are canonicalized to ``clamped_uniform(n_ctrl, degree)`` bitwise
    (asserted per the U2.1 knot-canonicalization hazard): the boundary curve and both patch
    directions all use this one vector, so the shared edge occupies one identical spline
    space.

    Args:
        chart: a :class:`app.param.Chart` (must be 4-valent — 4 boundary polyline refs).
        shared_curve_table: the :func:`fit_shared_curves` table.
        charts: the owning :class:`app.param.CubeMapCharts` (for the polyline vertices/uv).
        degree: the shared degree (for the knot canonicalization check).
        n_ctrl: the shared control-point count (rim length per side).

    Returns:
        ``dict`` with the four keys ``{"u0", "u1", "v0", "v1"}`` → ``(n_ctrl, 3)`` float64
        ``np.ndarray`` pinned rim values.

    Raises:
        ValueError: the chart is not 4-valent, its 4 polylines do not map to 4 distinct
            sides, or a shared curve's knots are not the canonical ``clamped_uniform``.
    """
    if len(chart.boundary) != 4:
        raise ValueError(
            f"chart is not 4-valent: {len(chart.boundary)} boundary polylines (need 4 to pin "
            f"the four uv sides)"
        )
    canonical = np.asarray(clamped_uniform(n_ctrl, degree), dtype=np.float64)
    rim: dict[str, np.ndarray] = {}
    for index, reversed_ref in chart.boundary:
        polyline = charts.polylines[index]
        control, knots = shared_curve_table[index]
        if not np.array_equal(np.asarray(knots, dtype=np.float64), canonical):
            raise ValueError(
                f"shared curve {index} knots are not clamped_uniform({n_ctrl}, {degree}) — "
                f"the shared edge would not occupy the identical spline space"
            )
        locals_ = np.searchsorted(chart.vertex_map, np.asarray(polyline.vertices, dtype=np.int64))
        side_key, ascending = _classify_uv_side(chart.uv[locals_])
        if side_key in rim:
            raise ValueError(f"chart maps two polylines onto the same uv side {side_key!r}")
        # Cross-check the uv-derived order against the ref's topological ``reversed`` flag:
        # the polyline's stored order is increasing-varying iff the walk's own direction on
        # this side (ascending on v0/u1) is flipped by ``reversed`` (two independent
        # orientation sources — the uv geometry and the boundary-chaining topology — must
        # agree, or the U7.1 boundary refs and the pinned uv have desynced).
        if ascending != (_SIDE_WALK_ASCENDING[side_key] != bool(reversed_ref)):
            raise ValueError(
                f"rim order inconsistency on side {side_key!r}: uv-derived ascending="
                f"{ascending} disagrees with boundary ref reversed={bool(reversed_ref)}"
            )
        control_np = np.asarray(control, dtype=np.float64)
        # control[k] sits at polyline.vertices[k] (endpoints interpolated); order it by the
        # side's increasing parameter, so poles[:, 0] / poles[0, :] index the way the rim does.
        rim[side_key] = control_np if ascending else control_np[::-1]
    if set(rim) != set(_SIDES):
        raise ValueError(f"chart's 4 polylines did not cover all four uv sides: {set(rim)}")
    return rim
