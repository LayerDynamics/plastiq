"""Closed-mode mesh→NURBS fitting pipeline — the watertight-blob GATE (SPEC-12 §5.1, FR-4, U7.3).

The closed-mode sibling of :mod:`app.pipeline` (open mode). Where the open pipeline fits ONE
patch to a disk-topology region, this fits a **closed genus-0 organic mesh** into SIX cube-map
NURBS patches sharing fitted boundary curves, then sews them into a single watertight B-rep
solid — the case SPEC-7's ``MakeFilling`` documents as fundamentally impossible ("a whole
organic blob stays faceted — a fundamental limit", ``freeform.py:14-17``). This is the GATE the
whole service exists to pass (SPEC-12 §8, U7).

    GLB bytes
      → app.meshio.load_mesh / detect_mode      (decode; the resolved mode MUST be "closed")
      → app.param.cube_map_charts               (6 disk charts + shared boundary polylines, U7.1)
      → app.boundary.fit_shared_curves          (each shared polyline fitted ONCE, U7.2)
      → per chart: app.boundary.pin_chart_rims  (the shared curves become the patch's rim rows)
                   app.core.fit_lsq.fit_scattered(rim=pinned)   (scattered LSQ, FLAT knots)
      → §6.2 payload (app.core.knots.flat_to_compact at the schema boundary)
      → app.schema.Surfaces                     (every §6.2 invariant, before OCCT — FR-6)
      → app.occ_step.surfaces_json_to_solid_step (crash-isolated: sew → MakeSolid → verify closure)
      → the FR-9 report (closure fields straight from the real OCCT checks)

Watertight **by construction, not by sew tolerance** (SPEC-7 D-3's sagitta lesson): each chart's
uv corners are pinned at its four junction vertices so every shared polyline is exactly one uv
side (U7.1-rev), and both incident patches pin that side to the SAME fitted curve control points
on a uniform ``(grid, grid)`` net + shared degree — so adjacent patches coincide along the seam
to solver precision (U7.2), and the 1e-6 sewing only merges already-coincident edges. Closure is
then **verified, never assumed** (FR-4): the report carries ``is_solid``/``is_valid``/
``free_edges``/``volume`` from ``occ_step``'s real OCCT checks. If the solid does not close,
``fit_closed`` returns an honest ``is_solid == False`` report — it never fakes closure — and the
U7.3 gate test fails loudly (the plan's stop-and-re-plan trigger).

Accuracy gate + faceted fallback (U7.4, FR-5/FR-8). After fitting each chart, its
``max_deviation`` (``params.deviation``) is gated against ``fidelity_tol``: a chart that misses
the tolerance — or whose fit or §6.2 schema validation fails — is replaced by the per-triangle
faceted faces of its mesh region (:func:`app.faceted.assemble_mixed_solid`), so the service ALWAYS
returns a valid B-rep STEP (nothing dropped). With no faceted charts (the default ``fidelity_tol``
is ``None`` ⇒ no gate, and the GATE fixture fits all six) the pure-NURBS path
(:func:`app.occ_step.surfaces_json_to_solid_step`) is taken UNCHANGED — the U7.3 GATE stays
byte-identical. The FR-9 report counts ``fitted_patches`` vs ``faceted_patches`` truthfully, and
``is_solid``/``is_valid``/``free_edges``/``volume`` come from the real OCCT closure checks either
way (a partial mix's mismatched NURBS/faceted seam yields an honest open shell,
``is_solid == False``; an all-faceted fallback reproduces the mesh and closes into a solid).

Closed-mode gradient refinement would have to freeze the pinned rims to preserve watertightness;
it is out of scope, so ``iters`` is recorded in the report but not applied (the pinned-rim LSQ fit
is what the GATE proves). Deterministic throughout (float64 CPU-stream solves, no RNG — NFR-1).
"""

from __future__ import annotations

import base64
import logging
import math

import mlx.core as mx
import numpy as np
from pydantic import ValidationError

from app import boundary, faceted, meshio, occ_step, param, schema
from app.core import losses
from app.core.eval import surface_point
from app.core.fit_lsq import ScatteredFit, fit_scattered
from app.core.knots import flat_to_compact
from app.core.params import deviation

__all__ = ["fit", "fit_closed"]

# OCCT runs in a spawned child (crash isolation); cap it so a hung solid conversion fails the
# job instead of blocking the caller (matches app.pipeline's open-mode bound).
_OCC_TIMEOUT_S = 60.0
logger = logging.getLogger(__name__)


def _surface_payload(fit: ScatteredFit) -> dict:
    """One §6.2 surface dict from a :class:`ScatteredFit` (FLAT → COMPACT knots at the boundary).

    Mirrors :mod:`app.pipeline`'s open-mode payload build: poles → nested lists, the FLAT
    core knot vectors grouped to COMPACT (unique values + parallel multiplicities) exactly
    once by :func:`app.core.knots.flat_to_compact`, non-rational (``weights == []``).
    """
    u_knots_c, u_mults = flat_to_compact(np.asarray(fit.u_knots).tolist())
    v_knots_c, v_mults = flat_to_compact(np.asarray(fit.v_knots).tolist())
    return {
        "poles": np.asarray(fit.poles, dtype=np.float64).tolist(),
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


def _aggregate_deviation(fits: list[tuple[ScatteredFit, np.ndarray]]) -> tuple[float, float]:
    """Aggregate the per-chart projection deviation into whole-solid ``(rms, max)`` (FR-9).

    Each chart's vertices are projected onto its own fitted patch
    (:func:`app.core.params.deviation`); the whole-solid max is the max over charts and the
    whole-solid rms is the count-weighted quadratic mean ``sqrt(Σ nᵢ·rmsᵢ² / Σ nᵢ)`` — exactly
    the rms of the pooled per-point distances, so it matches open mode's single-patch rms.
    """
    total_n = 0
    weighted_sq = 0.0
    dmax = 0.0
    for fit, points in fits:
        points_mx = mx.array(points, dtype=mx.float64)
        rms_i, max_i = deviation(
            points_mx, fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q
        )
        n_i = int(points.shape[0])
        weighted_sq += n_i * rms_i * rms_i
        total_n += n_i
        dmax = max(dmax, max_i)
    rms = math.sqrt(weighted_sq / total_n) if total_n else 0.0
    return rms, dmax


def _fidelity(fits: list[tuple[ScatteredFit, np.ndarray]], vertices: np.ndarray) -> tuple[float, float]:
    """Whole-solid Chamfer + SCD of the 6 fitted patches vs the input cloud (FR-9, U5.1).

    Each patch is sampled on a ``ceil(sqrt(nᵢ))²`` uv lattice over its knot domain (matching
    that chart's vertex density — the same device open mode uses), the samples pooled into one
    cloud ``a``, and both losses measured against the full input mesh vertices ``b`` (SCD
    normalizes by the input cloud's RMS radius — the GT scale). Grid ops are float64 (CPU-only
    in MLX, §5.3/D-9), so the lattice is built on the CPU stream.
    """
    if not fits:  # all charts faceted (FR-8 extreme): no NURBS patches to measure
        return 0.0, 0.0
    cloud = mx.array(np.asarray(vertices, dtype=np.float64), dtype=mx.float64)
    samples = []
    for fit, points in fits:
        nu, nv = fit.poles.shape[0], fit.poles.shape[1]
        side = max(2, math.ceil(math.sqrt(int(points.shape[0]))))
        with mx.stream(mx.cpu):
            u_lo, u_hi = fit.u_knots[fit.p].item(), fit.u_knots[nu].item()
            v_lo, v_hi = fit.v_knots[fit.q].item(), fit.v_knots[nv].item()
            gu = mx.linspace(u_lo, u_hi, side, dtype=mx.float64)
            gv = mx.linspace(v_lo, v_hi, side, dtype=mx.float64)
            uu = mx.broadcast_to(gu[:, None], (side, side)).reshape(-1)
            vv = mx.broadcast_to(gv[None, :], (side, side)).reshape(-1)
        samples.append(surface_point(fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q, uu, vv))
    with mx.stream(mx.cpu):  # float64 pooling is CPU-only in MLX (§5.3 / D-9)
        sampled = mx.concatenate(samples, axis=0)
    return float(losses.chamfer_distance(sampled, cloud)), float(
        losses.scaled_chamfer_distance(sampled, cloud)
    )


def _chart_region(chart, mesh_faces: np.ndarray, points: np.ndarray) -> faceted.FacetedRegion:
    """A chart's mesh region as a :class:`app.faceted.FacetedRegion` (local-indexed triangles).

    The chart's global-index triangles ``mesh_faces[chart.faces]`` are re-indexed into the chart's
    ascending ``vertex_map`` (exactly ``app.param._chart_submesh``'s ``searchsorted`` re-indexing),
    so the faceted faces reuse the same mesh coordinates (``points == vertices[chart.vertex_map]``)
    the neighbouring charts share.
    """
    global_tris = mesh_faces[chart.faces]
    local_tris = np.searchsorted(chart.vertex_map, global_tris)
    return faceted.FacetedRegion(
        vertices=np.asarray(points, dtype=np.float64), triangles=local_tris
    )


def _all_faceted_solid(mesh, *, degree: int, iters: int, fidelity_tol: float | None) -> dict:
    """Degrade to a single all-faceted watertight solid when cube-map charting can't produce charts.

    Cube-map charting assigns every face to one of 6 axis-aligned directions; deeply-concave genus-0
    meshes (e.g. a carved mask with overhangs) can produce a junction whose vertex fan is fully
    claimed, which :func:`app.param._repair_chart_labels` cannot dissolve. That is a *shape* limit,
    not invalid input — so rather than crash the job (the contract was correct-or-raise), we sew the
    whole mesh's triangles into one faceted solid via the SAME crash-isolated OCC assembly the mixed
    path uses. The result is a valid watertight B-rep (no smooth NURBS patches — honestly reported
    ``fitted_patches == 0`` with ``charting_degraded == True``)."""
    region = faceted.FacetedRegion(
        vertices=np.asarray(mesh.vertices, dtype=np.float64),
        triangles=np.asarray(mesh.faces, dtype=np.int64),
    )
    solid = faceted.assemble_mixed_solid({"surfaces": []}, [region], timeout=_OCC_TIMEOUT_S)
    report = {
        "patches": 1,
        "fitted_patches": 0,
        "faceted_patches": 1,
        "control_points": 0,
        "degree_u": degree,
        "degree_v": degree,
        "iters": iters,
        "chamfer": 0.0,  # faceted reproduces the mesh exactly → zero deviation
        "scd": 0.0,
        "rms_deviation": 0.0,
        "max_deviation": 0.0,
        "fidelity_tol": fidelity_tol,
        "is_solid": solid["is_solid"],
        "is_valid": solid["is_valid"],
        "free_edges": solid["free_edges"],
        "volume": solid["volume"],
        "mode": "closed",
        "charting_degraded": True,  # cube-map charting could not chart this shape (FR-5, honest)
    }
    return {"step": solid["step"], "surfaces": {"surfaces": []}, "report": report}


def fit_closed(
    glb_bytes: bytes,
    *,
    degree: int = 3,
    grid: int = 8,
    iters: int = 0,
    fidelity_tol: float | None = None,
) -> dict:
    """Fit a closed genus-0 mesh to a watertight 6-patch all-NURBS solid (SPEC-12 §5.1 closed mode).

    Args:
        glb_bytes: the raw GLB payload (a closed genus-0 organic mesh).
        degree: B-spline degree in both u and v, shared across all 6 patches (the uniform-grid
            watertightness requirement, FR-4); schema export bound is 2..8, so ``>= 2``.
        grid: control points per direction — the uniform ``grid × grid`` net every patch shares
            (``>= degree + 1``). Default ``8``. All patches MUST share this grid or the shared
            rims stop being watertight (FR-4).
        iters: recorded in the report for §6.1 parity but NOT applied in U7.3 (closed-mode
            gradient refinement would have to freeze the pinned rims to stay watertight — out of
            the gate's scope; the pinned-rim LSQ fit is what U7.3 proves).
        fidelity_tol: optional per-patch accuracy gate (FR-5, U7.4). When set, any chart whose
            fitted ``max_deviation`` exceeds it (or whose fit/schema fails) falls back to that
            chart's per-triangle faceted region; the solid is then assembled from the mix. Default
            ``None`` ⇒ no accuracy gate (a chart facets only if its fit/schema fails), so the
            ``blob.glb`` gate fixture stays pure 6-patch NURBS.

    Returns:
        ``{"step": <STEP text>, "surfaces": {"surfaces": [<§6.2 dict>]}, "report": <FR-9>}``. The
        ``surfaces`` list holds only the fitted (non-faceted) patches — up to 6, and empty in the
        all-faceted extreme. The report's ``is_solid``/``is_valid``/``free_edges``/``volume`` come
        straight from the real OCCT closure checks — a failed gate reports ``is_solid == False``
        honestly, never a faked solid — and ``fitted_patches``/``faceted_patches`` count the split.

    Raises:
        ValueError: the mesh is not closed genus-0 (an open mesh is :func:`app.pipeline.fit_open`),
            ``degree < 2``, or (via ``cube_map_charts``) the mesh cannot be split into 6 disk
            charts at all — a non-4-valent chart or a flipping uv map
            (:class:`app.meshio.UnsupportedTopologyError`). That whole-mesh charting failure
            precedes per-chart fitting, so the per-patch faceted gate cannot rescue it; the
            ``blob.glb`` gate fixture is 4-valent and never triggers it.
    """
    if degree < 2:
        raise ValueError(
            f"degree must be >= 2 for the §6.2 B-spline export (schema bound is 2..8); got {degree}"
        )
    if grid < degree + 1:
        raise ValueError(f"grid must be >= degree + 1 = {degree + 1} (got {grid})")

    mesh = meshio.load_mesh(glb_bytes)
    resolved = meshio.detect_mode(mesh, "auto")
    if resolved != "closed":
        raise ValueError(
            f"fit_closed handles closed genus-0 meshes only, but the mesh resolved to "
            f"{resolved!r} — an open (disk-topology) mesh is app.pipeline.fit_open, not the "
            f"closed-mode gate"
        )

    # U7.1: 6 cube-map charts + shared boundary polylines. U7.2: fit each shared polyline once,
    # so both incident patches pin the SAME rim curve (watertight by construction, R-1). A deeply
    # concave genus-0 shape can defeat cube-map charting (a fully-claimed junction fan) — that is a
    # shape limit, not invalid input, so degrade to an all-faceted watertight solid instead of
    # crashing the job (NFR-1 "nothing is ever dropped"; honestly reported charting_degraded).
    try:
        charts = param.cube_map_charts(mesh)
    except ValueError as exc:
        logger.warning("cube-map charting failed (%s); degrading to an all-faceted solid", exc)
        return _all_faceted_solid(mesh, degree=degree, iters=iters, fidelity_tol=fidelity_tol)
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    mesh_faces = np.asarray(mesh.faces, dtype=np.int64)
    shared_curves = boundary.fit_shared_curves(charts, vertices, degree=degree, n_ctrl=grid)

    # U7.4 accuracy gate (FR-5): fit each chart, then keep it as NURBS only if it fits and clears
    # fidelity_tol; otherwise fall back to that chart's per-triangle faceted region.
    fits: list[tuple[ScatteredFit, np.ndarray]] = []  # kept NURBS patches (fit, points)
    fitted_payloads: list[dict] = []  # parallel §6.2 dicts for the kept patches
    faceted_regions: list[faceted.FacetedRegion] = []  # charts that fell back to faceted
    for chart in charts.charts:
        points = vertices[chart.vertex_map]  # (nᵢ, 3) the chart's mesh vertices in 3D
        fit: ScatteredFit | None = None
        payload: dict | None = None
        gate_fail = False
        try:
            rim = boundary.pin_chart_rims(chart, shared_curves, charts, degree, grid)
            fit = fit_scattered(points, chart.uv, degree, degree, grid, grid, rim=rim)
            payload = _surface_payload(fit)
            # Per-patch §6.2 validation (FR-6): a schema-invalid patch facets instead of crashing.
            schema.NurbsSurface.model_validate(payload)
            if fidelity_tol is not None:
                points_mx = mx.array(points, dtype=mx.float64)
                _, max_dev = deviation(
                    points_mx, fit.poles, None, fit.u_knots, fit.v_knots, fit.p, fit.q
                )
                gate_fail = max_dev > fidelity_tol  # missed the accuracy gate → facet (FR-5)
        except (ValueError, ValidationError):
            gate_fail = True  # the fit or its schema failed → facet (FR-5)

        if gate_fail or fit is None or payload is None:
            faceted_regions.append(_chart_region(chart, mesh_faces, points))
        else:
            fits.append((fit, points))
            fitted_payloads.append(payload)

    surfaces_payload = {"surfaces": fitted_payloads}
    if faceted_regions:
        # Mixed (or all-)faceted assembly: fitted NURBS patches + faceted regions → one sew →
        # solid attempt → verified closure → STEP (crash-isolated). FR-6 validation of the fitted
        # surfaces happens inside assemble_mixed_solid (and again in its spawned worker).
        solid = faceted.assemble_mixed_solid(
            surfaces_payload, faceted_regions, timeout=_OCC_TIMEOUT_S
        )
    else:
        # Pure all-NURBS path (the U7.3 GATE) — UNCHANGED so it stays byte-identical. Validate
        # every §6.2 invariant before OCCT ever sees the data (FR-6); surfaces_json_to_solid_step
        # re-validates in-process and again in the spawned worker.
        schema.Surfaces(**surfaces_payload)
        # Crash-isolated sew → MakeSolid → OrientClosedSolid → verify closure (NbFreeEdges/IsValid/
        # volume). solid["is_solid"] is True only when a single shell sewed shut with zero free edges.
        solid = occ_step.surfaces_json_to_solid_step(surfaces_payload, timeout=_OCC_TIMEOUT_S)

    # Deviation / fidelity are measured over the FITTED patches only (faceted regions reproduce
    # the mesh exactly, deviation 0); _aggregate_deviation and _fidelity both return zeros when
    # there are no fitted patches (the all-faceted extreme).
    rms, dmax = _aggregate_deviation(fits)
    chamfer, scd = _fidelity(fits, vertices)

    report = {
        "patches": len(fits) + len(faceted_regions),  # logical patches (charts) — 6
        "fitted_patches": len(fits),  # charts kept as fitted NURBS patches (FR-9, truthful)
        "faceted_patches": len(faceted_regions),  # charts that fell back to faceted (FR-5/FR-9)
        "control_points": int(sum(fit.poles.shape[0] * fit.poles.shape[1] for fit, _ in fits)),
        "degree_u": degree,
        "degree_v": degree,
        "iters": iters,
        "chamfer": chamfer,
        "scd": scd,
        "rms_deviation": rms,
        "max_deviation": dmax,
        "fidelity_tol": fidelity_tol,
        # A "watertight VALID solid" must gate on is_solid AND is_valid together: is_solid alone
        # means a single shell was closed into a solid with free_edges == 0 — it does NOT itself
        # assert BRepCheck_Analyzer.IsValid() (a solid can close yet be geometrically invalid).
        "is_solid": solid["is_solid"],  # real OCCT closure (single closed shell → solid)
        "is_valid": solid["is_valid"],  # real BRepCheck_Analyzer.IsValid()
        "free_edges": solid["free_edges"],  # 0 ⇔ watertight (verified, never assumed)
        "volume": solid["volume"],  # GProp volume after outward orientation (metres³)
        "mode": "closed",
    }
    return {"step": solid["step"], "surfaces": surfaces_payload, "report": report}


def fit(payload: dict) -> dict:
    """``payload: dict`` adapter mirroring :func:`app.pipeline.fit` for the closed-mode path.

    Base64-decodes ``glb_base64`` and forwards the §6.1 fit knobs to :func:`fit_closed`. Returns
    the same ``{"step", "surfaces", "report"}`` shape. (U8 wires the open/closed mode dispatch
    into ``app.main``; this adapter keeps the closed path callable with the same payload contract.)
    """
    glb_bytes = base64.b64decode(payload["glb_base64"])
    return fit_closed(
        glb_bytes,
        degree=payload.get("degree", 3),
        grid=payload.get("grid", 8),
        iters=payload.get("iters", 0),
        fidelity_tol=payload.get("fidelity_tol"),
    )
