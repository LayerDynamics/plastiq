"""U6.3 — the open-mode fitting pipeline (`app/pipeline.py`), end-to-end on the real dome.glb.

These tests drive the WHOLE open-mode seam with no mocks: GLB bytes → ``meshio`` load +
mode detect → ``param`` harmonic disk map → ``core.fit_lsq.fit_scattered`` LSQ → ``core.params``
deviation → §6.2 payload (``core.knots.flat_to_compact`` at the schema boundary) →
``schema.Surfaces`` validation → crash-isolated ``occ_step.surfaces_json_to_step`` → the FR-9
report. With the four boundary rims pinned to the mesh polyline (FR-3, ``_boundary_rim``), the
boundary vertices — previously the worst-fit points on dome.glb at ~8.5e-3 m — are interpolated
exactly, so the fit tightens to rms ~1.5e-3 / max ~4.6e-3 m at grid=8 (an unpinned probe saw
2.69e-3 / 9.09e-3); the accuracy asserts here (rms < 5e-3, max < 2e-2) keep that proven ballpark
with headroom, not invented targets.

Result-shape contract (frozen by the landed `tests/test_api.py` and SPEC-12 §6.1): the result's
``surfaces`` field is the NESTED Surfaces object ``{"surfaces": [...]}`` (``test_api.py:344`` does
``body["surfaces"]["surfaces"]``), NOT a bare list — the U6.3 task's ``[<surface dict>]`` shorthand
is overridden by that landed test and the U9 client written to it. Both ``fit_open`` and the
``fit(payload)`` adapter therefore carry the nested object.

``iters=0`` is a COMPLETE supported mode (FR-2: pure LSQ), not a stub. ``iters > 0`` runs the
landed gradient refinement (``core/fit_grad.refine``, U5.2), wired into ``fit_open`` after the
LSQ init; ``fit_open`` then keeps whichever of the LSQ init and the refined fit is not worse on
the ``core.params`` PROJECTION deviation the report uses (best-of-init-or-refined ⇒ never worse
than the init on the reported metric, FR-2). Two ``iters > 0`` tests pin that: at the coarse
under-fitting grid=6 (rims not sewable, whole patch free to refine) refinement drives a strictly
better fit and best-of keeps it (``test_fit_open_iters_improves_fit``); at the service default
grid=16 refinement's Chamfer-best iterate DEGRADES the projection fit, so best-of falls back to
the init and the reported deviation is never worse than pure LSQ
(``test_fit_open_default_grid_never_worse_than_lsq`` — the batch-14 open review High).

Gated on the plastiq-nurbs env deps (mlx / trimesh / scipy / pythonocc), so it self-skips where
the fitting env is not installed. No conftest.py; everything deterministic, no RNG (NFR-1).
"""

import base64
import math
from pathlib import Path

import pytest

pytest.importorskip("mlx.core")
pytest.importorskip("trimesh")
pytest.importorskip("scipy")
pytest.importorskip("OCC.Core.Geom")

import mlx.core as mx  # noqa: E402
import numpy as np  # noqa: E402

from app import meshio, param, pipeline, schema  # noqa: E402
from app.core.eval import surface_point  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
DOME = FIXTURES / "dome.glb"  # open disk-topology region (mode "open")
BLOB = FIXTURES / "blob.glb"  # closed genus-0 mesh (mode "closed") — U7's pipeline, not U6.3

# The 15 FR-9 report fields the result MUST carry (SPEC-12 FR-9 / §6.1) — frozen verbatim by
# tests/test_api.py:35-51 and consumed by the @plastiq/nurbs client (U9). A missing/extra key is
# a silent contract break the rms/max asserts would not catch, so both tests below pin the set.
FR9_REPORT_KEYS = {
    "patches",
    "fitted_patches",
    "faceted_patches",
    "control_points",
    "degree_u",
    "degree_v",
    "iters",
    "chamfer",
    "scd",
    "rms_deviation",
    "max_deviation",
    "fidelity_tol",
    "is_solid",
    "is_valid",
    "mode",
}


def _dome_bytes() -> bytes:
    return DOME.read_bytes()


def _boundary_polyline_and_uv() -> tuple[np.ndarray, np.ndarray]:
    """The dome's ordered boundary polyline (3-D verts) and each vertex's harmonic-map uv.

    Reconstructed from the SAME real modules the pipeline parameterizes with (``meshio`` +
    ``param``), so the deviation below is measured against the exact boundary the fit saw —
    no mocks, no re-fitting.
    """
    mesh = meshio.load_mesh(_dome_bytes())
    loop = meshio.boundary_loops(mesh)[0]
    uv = param.harmonic_disk_map(mesh)
    verts = np.asarray(mesh.vertices, dtype=np.float64)[loop]
    return verts, uv[loop]


def _rim_deviation(result: dict) -> float:
    """Max distance between the RESULT surface, evaluated along the boundary uv, and the polyline.

    Rebuilds a flat-knot surface from the §6.2 payload the pipeline actually returned (compact
    knots expanded by ``np.repeat``), then evaluates it at the boundary vertices' uv — the
    fitted rim vs. the mesh boundary polyline it must interpolate (FR-3 sewability property).
    """
    surf = result["surfaces"]["surfaces"][0]
    poles = mx.array(np.asarray(surf["poles"], dtype=np.float64), dtype=mx.float64)
    uk = np.repeat(np.asarray(surf["u_knots"]), np.asarray(surf["u_mults"])).astype(np.float64)
    vk = np.repeat(np.asarray(surf["v_knots"]), np.asarray(surf["v_mults"])).astype(np.float64)
    verts, uvb = _boundary_polyline_and_uv()
    with mx.stream(mx.cpu):
        S = surface_point(
            poles, None,
            mx.array(uk, dtype=mx.float64), mx.array(vk, dtype=mx.float64),
            surf["u_degree"], surf["v_degree"],
            mx.array(uvb[:, 0], dtype=mx.float64), mx.array(uvb[:, 1], dtype=mx.float64),
        )
        S = np.asarray(S, dtype=np.float64)
    return float(np.linalg.norm(S - verts, axis=1).max())


def test_fit_open_rim_interpolates_boundary():
    """FR-3 sewability: the fitted patch rim INTERPOLATES the mesh boundary polyline < 1e-6.

    A disk-topology region is delegated (U10) by building its face from the returned surfaces
    JSON against the SAME mesh polyline its faceted/planar neighbours use, so the two coincide
    only if the fitted surface passes through that polyline's vertices (FR-3, ``freeform.py``'s
    coincident-boundary property). With ``rim=None`` the LSQ fit leaves the boundary vertices
    the worst-fit points on dome.glb — ~8.5e-3 m off (the batch-9 review High) — so the open
    pipeline pins each of the four uv-side rims to an exact interpolation of that side's
    boundary arc. grid=8 (arcs of 7 verts each ≤ 8 control points ⇒ interpolation feasible);
    the assert would fail at ~8.5e-3 against the unpinned fit.

    NB — this is VERTEX coincidence (the polyline's defining points lie on the surface), the
    property U10 delegation and FR-4's "interpolate by construction" both mean. The smooth
    degree-3 rim still bulges from the straight polyline *chords* between vertices by the
    boundary's sagitta; that facet-vs-arc mismatch is the acknowledged open limit ``freeform.py``
    documents (the "surface-intersection tail"), NOT what this < 1e-6 assert measures.
    """
    result = pipeline.fit_open(_dome_bytes(), iters=0, grid=8, degree=3)
    dev = _rim_deviation(result)
    assert dev < 1e-6, f"rim deviation {dev:.3e} m exceeds the FR-3 sewability bound 1e-6"


def test_fit_open_rim_stays_pinned_through_refine():
    """iters > 0: the returned fit's rim stays sewable < 1e-6 whichever fit best-of keeps (FR-3).

    At grid=8 the rim interpolates its boundary arc, so it is frozen through refine (``freeze`` =
    the pinned rim edges; gradient masking holds those control-net rows bitwise fixed, SPEC-12
    §5.4, D-9 float32). Both candidate fits are therefore sewable: the LSQ init (fit_scattered's
    pinned rim) and the refined fit (its frozen rim, widened back to f64 for the schema/OCCT path).
    ``fit_open``'s best-of-init-or-refined reports whichever does not regress the projection
    deviation — at this tight-init grid the refined Chamfer-best iterate degrades projection
    rms/max, so best-of falls back to the LSQ init — and EITHER way the returned rim interpolates
    the mesh boundary polyline far under the 1e-6 bound. This locks that the iters>0 path never
    returns an unsewable rim, regardless of which fit best-of selects.
    """
    result = pipeline.fit_open(_dome_bytes(), iters=60, grid=8, degree=3)
    dev = _rim_deviation(result)
    assert dev < 1e-6, f"iters>0 rim deviation {dev:.3e} m exceeds the FR-3 sewability bound 1e-6"
    assert result["report"]["iters"] == 60


def test_fit_open_dome_produces_real_step_and_populated_report():
    """dome.glb (iters=0, grid=8) → a real single-patch STEP + a fully populated FR-9 report."""
    result = pipeline.fit_open(_dome_bytes(), iters=0, grid=8, degree=3)

    assert set(result) == {"step", "surfaces", "report"}

    # Real OCCT STEP: a B-spline surface, exactly one face (single open patch).
    step = result["step"]
    assert "ISO-10303-21" in step
    assert step.count("B_SPLINE_SURFACE_WITH_KNOTS") == 1

    # `surfaces` is the NESTED §6.2 Surfaces object (frozen contract), and it re-validates.
    surfaces = result["surfaces"]
    assert isinstance(surfaces, dict) and "surfaces" in surfaces
    assert len(surfaces["surfaces"]) == 1
    schema.Surfaces(**surfaces)  # the fit→schema seam holds (raises on any §6.2 violation)

    # FR-9 report — exact key set, honest single-open-patch values, proven deviation ballpark.
    report = result["report"]
    assert set(report) == FR9_REPORT_KEYS
    assert report["patches"] == 1
    assert report["fitted_patches"] == 1
    assert report["faceted_patches"] == 0
    assert report["control_points"] == 8 * 8
    assert report["degree_u"] == 3 and report["degree_v"] == 3
    assert report["iters"] == 0
    assert report["mode"] == "open"
    assert report["is_solid"] is False  # a single open patch is a face, not a solid
    assert report["is_valid"] is True
    # rms/max come from core.params.deviation (real projection distances), not a stub.
    assert report["rms_deviation"] < 5e-3, report["rms_deviation"]
    assert report["max_deviation"] < 2e-2, report["max_deviation"]
    assert report["rms_deviation"] > 0.0 and report["max_deviation"] > 0.0
    # chamfer/scd come from core.losses (fitted-surface sampling vs. the input cloud) — real
    # finite non-negative fidelity numbers now, no longer the honest None placeholder.
    assert report["chamfer"] is not None and math.isfinite(report["chamfer"])
    assert report["chamfer"] >= 0.0, report["chamfer"]
    assert report["scd"] is not None and math.isfinite(report["scd"])
    assert report["scd"] >= 0.0, report["scd"]


def test_fit_open_rejects_closed_mesh():
    """A closed mesh (blob.glb) is U7's pipeline — fit_open raises a clear open-mode error."""
    with pytest.raises(ValueError, match="open"):
        pipeline.fit_open(BLOB.read_bytes(), iters=0, grid=8, degree=3)


def test_fit_open_iters_improves_fit():
    """iters > 0 refines the LSQ init (core/fit_grad.refine) into a strictly better fit (FR-2/NFR-2).

    Grid is 6 on purpose, and it is the ONE regime where gradient refinement demonstrably helps
    once the FR-3 boundary rims are pinned. dome.glb's boundary arcs carry 7 vertices each, so at
    grid=6 the six-control-point rim cannot interpolate them (residual ~1.1e-1 ≫ 1e-6): the rim is
    NOT sewable and therefore NOT frozen during refine (``fit_open`` gates the freeze on
    sewability), leaving the whole under-fit patch free to improve exactly as it did before rim
    pinning. On the real dome.glb at grid=6, refinement drops the projection deviation
    substantially — measured rms ~2.0e-2 → ~1.1e-2 (~46% lower) and max ~1.0e-1 → ~4.7e-2
    (~53% lower). At grid ≥ 7 the rim interpolates (and is frozen), and the pinned init already
    fits so tightly (rms ~1.5e-3 at grid=8) that refinement — which minimises Chamfer on its own
    lattice, not the projection metric — no longer lowers projection rms; the coarse under-fitting
    net is where the FR-2 refinement win is real.

    The assertion is on rms/max deviation — the real projection metric — NOT on the report
    chamfer. ``fit_grad.refine`` minimises Chamfer on its own FIXED ``n_grid`` lattice and keeps
    the best iterate by *that* Chamfer, while the report re-samples chamfer on a different
    (``ceil(sqrt(M))``) lattice; so best-iterate protects the internal chamfer, not the report's,
    and at this under-fitting grid the report chamfer can tick slightly up even as the surface
    fits the input cloud markedly better. The refined patch (its f32 poles/knots converted back
    to f64) still exports a real, re-validating single-patch STEP.

    ``fit_open``'s best-of-init-or-refined keeps the refined fit only when it does not regress the
    projection deviation, so a bare ``<=`` would be tautological (best-of can never report worse
    than the init). This test instead asserts a STRICT drop: refinement genuinely helps at grid=6,
    so best-of KEEPS the refined fit and the reported deviation is strictly below pure LSQ. The
    fragile fixed-margin (``< 0.8 * base``) slice is dropped — a plain strict ``<`` proves
    refinement helps without pinning a specific percentage that float32 cross-version reduction
    noise (NFR-1) could wobble across.
    """
    grid = 6
    base = pipeline.fit_open(_dome_bytes(), iters=0, grid=grid, degree=3)["report"]
    refined_result = pipeline.fit_open(_dome_bytes(), iters=150, grid=grid, degree=3)
    refined = refined_result["report"]

    # iters is carried through honestly (pure-LSQ 0 vs the refined budget).
    assert base["iters"] == 0
    assert refined["iters"] == 150

    # Real projection deviation is STRICTLY lower after refinement (best-of keeps the refined fit
    # because it improves both metrics here — measured ~46% rms / ~53% max on this fixture). A
    # strict drop, not a fixed margin: proves refinement helps without a float32-fragile threshold.
    assert refined["rms_deviation"] < base["rms_deviation"], (
        base["rms_deviation"],
        refined["rms_deviation"],
    )
    assert refined["max_deviation"] < base["max_deviation"], (
        base["max_deviation"],
        refined["max_deviation"],
    )

    # The refined (f32→f64-converted) geometry still exports a valid single-patch STEP that
    # re-validates against the §6.2 schema — the conversion fed OCCT genuine float64 geometry.
    assert refined_result["step"].count("B_SPLINE_SURFACE_WITH_KNOTS") == 1
    schema.Surfaces(**refined_result["surfaces"])
    assert refined["is_valid"] is True
    assert refined["patches"] == 1


def test_fit_adapter_decodes_base64_and_matches_fit_open():
    """fit(payload) decodes glb_base64 + params and returns the same result as fit_open."""
    payload = {
        "glb_base64": base64.b64encode(_dome_bytes()).decode("ascii"),
        "mode": "auto",
        "degree": 3,
        "grid": 8,
        "iters": 0,
        "fidelity_tol": None,
    }
    adapted = pipeline.fit(payload)
    direct = pipeline.fit_open(_dome_bytes(), mode="auto", degree=3, grid=8, iters=0)

    # Same result shape as fit_open, and the frozen nested-surfaces contract.
    assert set(adapted) == {"step", "surfaces", "report"}
    assert adapted["surfaces"]["surfaces"], "result.surfaces must be the nested Surfaces object"
    assert set(adapted["report"]) == FR9_REPORT_KEYS
    schema.Surfaces(**adapted["surfaces"])

    # Deterministic pipeline ⇒ the adapter's geometry + report equal the direct call's.
    assert adapted["surfaces"] == direct["surfaces"]
    assert adapted["report"] == direct["report"]


def test_fit_open_is_deterministic():
    """Two runs → identical surfaces + report (STEP carries OCCT per-process counters, so it is
    compared at the surfaces/report level — the geometry the client actually consumes)."""
    a = pipeline.fit_open(_dome_bytes(), iters=0, grid=8, degree=3)
    b = pipeline.fit_open(_dome_bytes(), iters=0, grid=8, degree=3)
    assert a["surfaces"] == b["surfaces"]
    assert a["report"] == b["report"]


def test_fit_open_default_grid_never_worse_than_lsq():
    """FR-2 regression (batch-14 open-pipeline review High): at the SERVICE DEFAULT
    (grid=16, iters=200) the reported projection deviation is NEVER worse than the pure-LSQ init.

    ``fit_grad.refine`` keeps its best iterate by CHAMFER on its own 24² sampling lattice, but
    the FR-9 report and the FR-5 accuracy gate consume ``params.deviation`` PROJECTION rms/max —
    the two metrics diverge. Before the pipeline-level best-of-init-or-refined, this exact
    default operating point regressed hard: iters=0 gave rms ~5.48e-5 / max ~3.62e-4 while
    iters=200 reported rms ~3.95e-3 / max ~9.35e-3 (~72x / ~26x WORSE) — a materially degraded
    fit that could spuriously trip the faceted fallback (U7.4) even though pure LSQ fit tightly.

    ``fit_open`` now recomputes ``params.deviation`` for BOTH the LSQ init and the refined fit
    and reports whichever does not regress the projection metric (refined is kept only when it
    is ``<=`` the init on rms AND max, otherwise the init is kept), so FR-2's "never worse than
    the init" holds on the REPORTED deviation. This is the default the ``/fit`` API and the
    ``fit(payload)`` adapter both use, so the regression here is what real callers would hit.
    """
    grid = 16
    base = pipeline.fit_open(_dome_bytes(), iters=0, grid=grid, degree=3)["report"]
    refined_result = pipeline.fit_open(_dome_bytes(), iters=200, grid=grid, degree=3)
    refined = refined_result["report"]

    # The reported deviation is never worse than the LSQ init on EITHER metric the report / the
    # FR-5 gate use — the 72x/26x regression is gone (best-of-init-or-refined falls back to the
    # init here, since refinement's Chamfer best-iterate degrades the projection fit).
    assert refined["rms_deviation"] <= base["rms_deviation"], (
        base["rms_deviation"],
        refined["rms_deviation"],
    )
    assert refined["max_deviation"] <= base["max_deviation"], (
        base["max_deviation"],
        refined["max_deviation"],
    )
    # The chosen fit stays sewable (FR-3): whichever fit best-of keeps, its rim interpolates the
    # mesh boundary polyline < 1e-6 (the init's pinned rim and the refined fit's frozen rim both
    # satisfy this at grid=16).
    dev = _rim_deviation(refined_result)
    assert dev < 1e-6, f"chosen-fit rim deviation {dev:.3e} m exceeds the FR-3 sewability bound 1e-6"
    assert refined["iters"] == 200
