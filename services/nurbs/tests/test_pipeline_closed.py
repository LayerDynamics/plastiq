"""U7.3 — THE GATE: a closed organic mesh → a watertight, all-NURBS B-rep STEP solid.

This is the milestone that proves the service's entire reason to exist — the closed/organic
case SPEC-7's ``MakeFilling`` documents as fundamentally impossible ("a whole organic blob
stays faceted — a fundamental limit", ``freeform.py:14-17``). ``fit_closed`` takes the closed
genus-0 ``blob.glb``, splits it into 6 cube-map charts sharing fitted boundary curves (U7.1/
U7.2), pins each patch's rims to the shared curves (watertight *by construction*, not by sew
tolerance — SPEC-7 D-3's sagitta lesson), and sews the 6 NURBS faces into a solid whose closure
is **verified, never assumed** (SPEC-12 FR-4, reconstruct FR-7): ``NbFreeEdges() == 0``,
``BRepCheck_Analyzer.IsValid()``, and a positive ``GProp`` volume within tolerance of the mesh.

The gate criteria are hard asserts, not xfail/skip: if the solid does not close and validate,
these tests FAIL LOUDLY — that is the plan's stop-and-re-plan trigger (U7 gate must pass before
U8+ investment), never something to paper over.

Volume tolerance rationale: ``blob.glb`` is a coarse (icosphere subdivisions=2) faceted mesh
whose flat facets *under*-estimate the smooth volume, so the NURBS solid is expected to come out
slightly larger. The observed grid=8 fit is +~3.1% over the mesh volume; the assert uses a 10%
relative band — comfortably above the smoothing gap yet tight enough to catch a collapsed cap or
an inside-out (negative-volume) orientation failure.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.ShapeAnalysis import ShapeAnalysis_FreeBounds
from OCC.Core.STEPControl import STEPControl_Reader
from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_WIRE
from OCC.Core.TopExp import TopExp_Explorer

from app.meshio import load_mesh
from app.pipeline_closed import fit_closed

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# The GATE volume band (see the module docstring): the NURBS solid must agree with the coarse
# mesh volume to within this relative tolerance. Observed grid=8 fit is +~3.1%.
_VOLUME_REL_TOL = 0.10


def _bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


@pytest.fixture(scope="module")
def blob_result() -> dict:
    """``fit_closed(blob.glb)`` computed once — the shared GATE artifact (default grid=8)."""
    return fit_closed(_bytes("blob.glb"))


@pytest.fixture(scope="module")
def blob_mesh_volume() -> float:
    return float(load_mesh(_bytes("blob.glb")).volume)


def _count(shape, topype) -> int:
    explorer = TopExp_Explorer(shape, topype)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def _reimport(step_text: str, tmp_path):
    path = tmp_path / "reimport.step"
    path.write_text(step_text, encoding="utf-8")
    reader = STEPControl_Reader()
    assert reader.ReadFile(str(path)) == IFSelect_RetDone
    assert reader.TransferRoots() > 0
    return reader.OneShape()


# --- THE GATE ------------------------------------------------------------------------------


def test_gate_blob_is_watertight_nurbs_solid(blob_result, blob_mesh_volume) -> None:
    """THE GATE: blob.glb → a watertight, valid, positive-volume all-NURBS solid.

    Fails loudly (never xfail/skip) if closure is not achieved — the stop-and-re-plan trigger.
    """
    report = blob_result["report"]
    print(
        f"GATE blob: is_solid={report['is_solid']} is_valid={report['is_valid']} "
        f"free_edges={report['free_edges']} volume={report['volume']:.6f} "
        f"(mesh {blob_mesh_volume:.6f}) rms={report['rms_deviation']:.3e} "
        f"max={report['max_deviation']:.3e}"
    )

    # Closure verified, never assumed (SPEC-12 FR-4, reconstruct FR-7).
    assert report["free_edges"] == 0, f"solid has {report['free_edges']} free edges — not watertight"
    assert report["is_solid"] is True, "assembly did not produce a closed solid"
    assert report["is_valid"] is True, "BRepCheck_Analyzer rejected the solid"

    # Positive volume within tolerance of the input mesh volume.
    assert report["volume"] > 0.0, f"non-positive volume {report['volume']} (inside-out solid?)"
    rel = abs(report["volume"] - blob_mesh_volume) / blob_mesh_volume
    assert rel < _VOLUME_REL_TOL, (
        f"solid volume {report['volume']:.6f} differs from mesh volume "
        f"{blob_mesh_volume:.6f} by {rel:.1%} (> {_VOLUME_REL_TOL:.0%})"
    )

    # Six all-NURBS non-rational patches, no faceted fallback (U7.3 is pure NURBS).
    surfaces = blob_result["surfaces"]["surfaces"]
    assert len(surfaces) == 6, f"expected 6 cube-map patches, got {len(surfaces)}"
    for surface in surfaces:
        assert surface["weights"] == [], "GATE patches must be non-rational (weights == [])"
    assert report["mode"] == "closed"
    assert report["patches"] == 6
    assert report["fitted_patches"] == 6
    assert report["faceted_patches"] == 0


def test_gate_step_reimports_as_single_closed_solid(blob_result, tmp_path) -> None:
    """The STEP re-imports as ONE closed solid of 6 B-spline faces with NO free boundaries.

    Zero free boundaries on the re-imported shape is the adjacent-patch seam coincidence
    (U7.2's shared rims) carried all the way through the solid — watertight by construction.
    """
    step_text = blob_result["step"]
    assert step_text.strip()
    # Six B_SPLINE_SURFACE_WITH_KNOTS faces (the compact-knot handoff, non-rational form).
    assert step_text.count("B_SPLINE_SURFACE_WITH_KNOTS") == 6, step_text.count(
        "B_SPLINE_SURFACE_WITH_KNOTS"
    )
    assert "RATIONAL_B_SPLINE_SURFACE" not in step_text

    shape = _reimport(step_text, tmp_path)
    assert _count(shape, TopAbs_SOLID) == 1, "STEP is not a single closed solid"
    assert _count(shape, TopAbs_FACE) == 6, "solid does not have exactly 6 NURBS faces"

    # No free boundaries: ShapeAnalysis_FreeBounds finds zero open (and zero closed) free wires.
    free = ShapeAnalysis_FreeBounds(shape)
    assert _count(free.GetOpenWires(), TopAbs_WIRE) == 0, "solid has open free boundaries"
    assert _count(free.GetClosedWires(), TopAbs_WIRE) == 0, "solid has closed free boundaries"


# --- detect_mode rejection -----------------------------------------------------------------


def test_fit_closed_rejects_open_mesh() -> None:
    """An open (disk-topology) mesh must be rejected clearly — closed mode is genus-0 only."""
    with pytest.raises(ValueError, match="open|closed"):
        fit_closed(_bytes("dome.glb"))


# --- determinism ---------------------------------------------------------------------------


def test_fit_closed_deterministic(blob_result) -> None:
    """Two runs agree on is_solid and volume (STEP text modulo OCCT per-process entity ids)."""
    again = fit_closed(_bytes("blob.glb"))
    assert again["report"]["is_solid"] == blob_result["report"]["is_solid"]
    assert again["report"]["is_valid"] == blob_result["report"]["is_valid"]
    assert again["report"]["free_edges"] == blob_result["report"]["free_edges"]
    # GProp integration is deterministic; compare across separate spawn processes with a tight
    # relative tolerance rather than bitwise (the STEP carries per-process entity counters).
    v1, v2 = blob_result["report"]["volume"], again["report"]["volume"]
    assert abs(v1 - v2) <= 1e-9 * max(1.0, abs(v1)), f"volume not deterministic: {v1} vs {v2}"


# --- U7.4: the accuracy gate + faceted fallback (FR-5 / FR-8) ------------------------------
#
# The default (no fidelity_tol) fits all 6 charts (the GATE above). U7.4 adds a per-patch
# accuracy gate: any chart whose fitted max_deviation exceeds ``fidelity_tol`` (or whose fit /
# schema fails) is replaced by the per-triangle faceted faces of its mesh region, and the solid
# is assembled from the mix — so the service ALWAYS returns a valid STEP (FR-8), nothing dropped,
# and the report counts fitted vs faceted patches truthfully (FR-9).
#
# The tolerances below are chosen from the measured per-chart deviations of ``blob.glb`` at the
# default grid=8: two well-fit caps at ~2.2e-4 and four sides at ~6.0e-2 / ~7.6e-2. So:
#   * tol = 1e-3 facets the four sides and keeps the two caps  → a GENUINE partial NURBS+faceted
#     mix in one sew (fitted_patches == 2, faceted_patches == 4);
#   * tol = 1e-9 facets all six                                 → the all-faceted extreme.

# Partial-mix gate: above the two caps' deviation (~2.2e-4), below the four sides' (~6.0e-2).
_PARTIAL_TOL = 1e-3
# All-faceted gate: below every chart's deviation.
_ALL_FACETED_TOL = 1e-9


@pytest.fixture(scope="module")
def partial_result() -> dict:
    """``fit_closed(blob.glb, fidelity_tol=1e-3)`` — 2 NURBS caps + 4 faceted sides (once)."""
    return fit_closed(_bytes("blob.glb"), fidelity_tol=_PARTIAL_TOL)


@pytest.fixture(scope="module")
def all_faceted_result() -> dict:
    """``fit_closed(blob.glb, fidelity_tol=1e-9)`` — every chart falls back to faceted (once)."""
    return fit_closed(_bytes("blob.glb"), fidelity_tol=_ALL_FACETED_TOL)


def test_forced_fallback_partial_mix_counts(partial_result, blob_result) -> None:
    """A tiny-enough tol facets the four high-deviation sides; the two caps stay NURBS.

    Contrasts with the default (``blob_result``): default fits all 6, faceted_patches == 0.
    """
    report = partial_result["report"]
    print(
        f"PARTIAL fallback: fitted={report['fitted_patches']} faceted={report['faceted_patches']} "
        f"patches={report['patches']} is_solid={report['is_solid']} is_valid={report['is_valid']} "
        f"free_edges={report['free_edges']} cps={report['control_points']}"
    )
    # Truthful fitted-vs-faceted counts (FR-9): the four sides facet, the two caps fit.
    assert report["faceted_patches"] == 4, "the four high-deviation sides must fall back to faceted"
    assert report["fitted_patches"] == 2, "the two well-fit caps must stay NURBS"
    assert report["fitted_patches"] < 6 and report["faceted_patches"] > 0
    assert report["patches"] == report["fitted_patches"] + report["faceted_patches"] == 6
    assert report["control_points"] == 2 * 8 * 8, "only the 2 fitted caps carry a control net"
    assert report["mode"] == "closed"
    assert report["fidelity_tol"] == _PARTIAL_TOL

    # Contrast: the default fit facets nothing (the GATE is pure NURBS).
    assert blob_result["report"]["faceted_patches"] == 0
    assert blob_result["report"]["fitted_patches"] == 6


def test_forced_fallback_partial_mix_is_valid_step(partial_result, tmp_path) -> None:
    """The mixed assembly is a VALID B-rep STEP with both face types (FR-8).

    The NURBS caps' rims are the fitted shared curves; the faceted sides' rims are the raw mesh
    polylines. Those differ by >> the 1e-6 sew tol, so the seam does not merge — the shape is an
    honest open shell (``is_solid == False``), never a faked solid — but it is still valid and
    re-imports, carrying the 2 NURBS caps + the faceted side triangles.
    """
    report = partial_result["report"]
    # A mismatched NURBS/faceted seam ⇒ free edges ⇒ not a closed solid (verified, never assumed).
    assert report["is_solid"] is False, "the fitted/faceted seam cannot close — is_solid must be honest"
    assert report["free_edges"] > 0
    assert report["is_valid"] is True, "an open shell is still a valid B-rep (FR-8)"

    step_text = partial_result["step"]
    assert step_text.strip()
    # Exactly the two fitted caps are NURBS; the four sides are faceted planar faces.
    assert step_text.count("B_SPLINE_SURFACE_WITH_KNOTS") == 2
    assert "RATIONAL_B_SPLINE_SURFACE" not in step_text

    shape = _reimport(step_text, tmp_path)
    assert _count(shape, TopAbs_FACE) > 2, "the STEP must carry the faceted side triangles too"


def test_all_faceted_extreme_is_watertight_solid(all_faceted_result, blob_mesh_volume, tmp_path) -> None:
    """A tol below every chart facets all six → the whole mesh, still a watertight solid (FR-8).

    All-faceted reproduces the input mesh's triangles exactly, so the sewn shape closes into a
    valid solid whose volume equals the mesh volume — nothing is dropped, the service degrades to
    the honest faceted baseline rather than failing.
    """
    report = all_faceted_result["report"]
    print(
        f"ALL-FACETED fallback: fitted={report['fitted_patches']} faceted={report['faceted_patches']} "
        f"is_solid={report['is_solid']} volume={report['volume']:.6f} (mesh {blob_mesh_volume:.6f})"
    )
    assert report["faceted_patches"] == 6, "every chart must fall back to faceted"
    assert report["fitted_patches"] == 0
    assert report["patches"] == 6
    assert report["control_points"] == 0, "no fitted patch ⇒ no control points"
    # No fitted patch ⇒ the NURBS deviation/fidelity metrics are reported as zero, not stale.
    assert report["rms_deviation"] == 0.0
    assert report["max_deviation"] == 0.0
    assert report["chamfer"] == 0.0
    assert report["scd"] == 0.0

    # The all-faceted mesh is watertight (verified, never assumed).
    assert report["is_solid"] is True
    assert report["is_valid"] is True
    assert report["free_edges"] == 0
    assert report["volume"] > 0.0
    rel = abs(report["volume"] - blob_mesh_volume) / blob_mesh_volume
    assert rel < _VOLUME_REL_TOL, f"faceted volume {report['volume']} vs mesh {blob_mesh_volume} ({rel:.1%})"

    step_text = all_faceted_result["step"]
    assert "B_SPLINE_SURFACE_WITH_KNOTS" not in step_text, "all-faceted STEP has no NURBS faces"
    shape = _reimport(step_text, tmp_path)
    assert _count(shape, TopAbs_SOLID) == 1, "all-faceted mesh must re-import as one closed solid"
    assert _count(shape, TopAbs_FACE) > 6, "the faceted solid has one face per mesh triangle"


def test_fallback_deterministic() -> None:
    """The faceted fallback is deterministic: two partial-mix runs agree (NFR-1)."""
    a = fit_closed(_bytes("blob.glb"), fidelity_tol=_PARTIAL_TOL)["report"]
    b = fit_closed(_bytes("blob.glb"), fidelity_tol=_PARTIAL_TOL)["report"]
    assert a["fitted_patches"] == b["fitted_patches"]
    assert a["faceted_patches"] == b["faceted_patches"]
    assert a["is_solid"] == b["is_solid"]
    assert a["free_edges"] == b["free_edges"]
    assert abs(a["volume"] - b["volume"]) <= 1e-9 * max(1.0, abs(a["volume"]))
