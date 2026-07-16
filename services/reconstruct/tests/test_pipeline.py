"""Real reconstruction geometry (no mocks): triangle meshes → valid B-rep STEP."""

import os

import numpy as np
import pytest
import trimesh

import app.pipeline
from app.faceted import faceted_shape
from app.occ_pool import IsolatedWorkerError
from app.occ_step import shape_to_step
from app.pipeline import reconstruct, reconstruct_isolated

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _glb(name: str) -> bytes:
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def _cube_arrays(size: float = 0.02) -> tuple[np.ndarray, np.ndarray]:
    box = trimesh.creation.box(extents=(size, size, size))
    return np.asarray(box.vertices, dtype=float), np.asarray(box.faces, dtype=np.int64)


def test_watertight_cube_reconstructs_to_valid_solid():
    v, f = _cube_arrays()
    res = faceted_shape(v, f)
    assert res.faces_built == 12  # 6 faces × 2 triangles
    assert res.is_valid
    assert res.is_solid  # a closed cube sews into a solid


def test_step_output_is_a_real_step_file():
    v, f = _cube_arrays()
    step = shape_to_step(faceted_shape(v, f).shape)
    assert step.startswith("ISO-10303-21")
    assert "END-ISO-10303-21" in step


def test_reconstruct_glb_end_to_end_faceted():
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    res = reconstruct(glb, "glb", method="faceted")
    assert res.report.method == "faceted"
    assert res.report.is_valid
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")


def test_degenerate_triangles_are_skipped():
    # A quad (two good triangles) plus a zero-area sliver (repeated vertex index).
    v = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=float)
    f = np.array([[0, 1, 2], [0, 2, 3], [0, 1, 1]], dtype=np.int64)
    res = faceted_shape(v, f)
    assert res.faces_built == 2  # the degenerate triangle was dropped


def test_open_mesh_falls_back_to_a_shell_not_a_solid():
    # A single triangle is an open shell — valid B-rep, but not a closed solid.
    v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=float)
    f = np.array([[0, 1, 2]], dtype=np.int64)
    res = faceted_shape(v, f)
    assert res.faces_built == 1
    assert res.is_solid is False
    assert res.is_valid


def test_report_face_type_breakdown_faceted_is_all_faceted():
    # FR-9 / §6: a faceted result reports every face as faceted; nothing analytic/freeform.
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    r = reconstruct(glb, "glb", method="faceted").report
    assert r.faceted_faces == r.faces_built > 0
    assert r.planar_faces == 0
    assert r.curved_faces == 0
    assert r.freeform_faces == 0


def test_fitted_route_failure_falls_back_to_faceted(monkeypatch):
    # NFR-1 at the exception boundary: if fitted_shape itself raises, the pipeline must still
    # emit a valid STEP via the per-triangle faceted baseline instead of failing the job.
    def boom(vertices, faces, **kwargs):
        raise RuntimeError("fitted route blew up")

    monkeypatch.setattr(app.pipeline, "fitted_shape", boom)
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    res = reconstruct(glb, "glb", method="fitted")
    assert res.report.method == "faceted"  # degraded to the baseline, not dropped
    assert res.report.is_valid
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")
    assert "END-ISO-10303-21" in res.step
    # 7-L2: the crash is recorded as an "error" attempt — not hidden behind the fallback.
    assert [(a.route, a.outcome) for a in res.report.attempted] == [
        ("fitted", "error"),
        ("faceted", "matched"),
    ]
    assert "fitted route blew up" in res.report.attempted[0].error


# ── 7-L2: per-route attempt observability (report.attempted) ────────────────────


def test_attempted_records_no_match_for_clean_declines():
    # A box: every analytic route declines CLEANLY (returns None, no swallowed exception) →
    # "no_match", and the fitted route that finally built it is "matched" — in chain order.
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    r = reconstruct(glb, "glb", method="auto").report
    assert [(a.route, a.outcome) for a in r.attempted] == [
        ("single_primitive", "no_match"),
        ("cut_sphere", "no_match"),
        ("revolution", "no_match"),
        ("csg", "no_match"),
        ("cut_cylinder", "no_match"),
        ("fitted", "matched"),
    ]
    assert all(a.error is None for a in r.attempted)


def test_attempted_records_only_the_matching_route_when_first_route_hits():
    glb = trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48).export(file_type="glb")
    r = reconstruct(glb, "glb", method="auto").report
    assert [(a.route, a.outcome) for a in r.attempted] == [("single_primitive", "matched")]


def test_attempted_records_error_when_a_route_raises(monkeypatch):
    # An OCCT crash inside a route must be visible as outcome="error" in the report — while
    # the chain still degrades gracefully to a valid STEP (FR-8 unchanged).
    def boom(vertices, faces, **kwargs):
        raise RuntimeError("csg route blew up")

    monkeypatch.setattr(app.pipeline, "reconstruct_csg", boom)
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    res = reconstruct(glb, "glb", method="auto")
    routes = {a.route: a for a in res.report.attempted}
    assert routes["csg"].outcome == "error"
    assert "RuntimeError" in routes["csg"].error and "csg route blew up" in routes["csg"].error
    assert res.report.method == "fitted"  # the box still reconstructs downstream
    assert res.report.is_solid
    assert res.step.startswith("ISO-10303-21")
    assert "END-ISO-10303-21" in res.step


def test_attempted_surfaces_route_internal_swallowed_exceptions(monkeypatch):
    # detect.try_single_primitive CATCHES hypothesis crashes internally (a failed hypothesis
    # is simply not a candidate). 7-L2: when the route then returns None, the report must say
    # "error" — not pretend the mesh cleanly didn't match.
    import app.detect

    def boom(vertices, face_normals):
        raise RuntimeError("cylinder fit blew up")

    monkeypatch.setattr(app.detect, "fit_cylinder", boom)
    glb = trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48).export(file_type="glb")
    res = reconstruct(glb, "glb", method="auto")
    routes = {a.route: a for a in res.report.attempted}
    assert routes["single_primitive"].outcome == "error"
    assert "cylinder fit blew up" in routes["single_primitive"].error
    assert res.report.is_solid  # still degraded to a later route (FR-8)
    assert res.step.startswith("ISO-10303-21")


def test_attempted_surfaces_freeform_region_error_inside_fitted(monkeypatch):
    # 7-L2 residual (task #44): a freeform region crash is swallowed INSIDE fitted_shape (the
    # region falls back faceted, FR-8), so it never raised out of the route. The fitted attempt
    # must still record outcome="error" with the detail — while the fitted result itself is the
    # one emitted (valid STEP, region kept per-triangle), NOT degraded to the faceted baseline.
    import app.freeform

    class _BoomFilling:
        """Stands in for BRepOffsetAPI_MakeFilling; Build() crashes like a hard OCCT failure."""

        def Add(self, *args):
            return None

        def Build(self):
            raise RuntimeError("filling blew up")

    monkeypatch.setattr(app.freeform, "BRepOffsetAPI_MakeFilling", _BoomFilling)
    res = reconstruct(_glb("domed_box.glb"), "glb", method="fitted")
    assert res.report.method == "fitted"  # the fitted result is still the emitted one
    assert res.report.freeform_faces == 0  # the domed region's freeform build crashed…
    assert res.report.faceted_faces > 0  # …and fell back to per-triangle faces (FR-8)
    assert res.report.is_valid
    assert res.step.startswith("ISO-10303-21")
    assert "END-ISO-10303-21" in res.step
    assert [(a.route, a.outcome) for a in res.report.attempted] == [("fitted", "error")]
    assert "MakeFilling" in res.report.attempted[0].error
    assert "filling blew up" in res.report.attempted[0].error


def test_attempted_clean_fitted_freeform_run_records_matched_with_no_error():
    # The counterpart guard: when the freeform regions build cleanly, the fitted attempt is
    # "matched" with no error detail — the collector must not add noise to healthy runs.
    res = reconstruct(_glb("domed_box.glb"), "glb", method="fitted")
    assert res.report.freeform_faces > 0  # freeform really engaged (not the faceted fallback)
    assert [(a.route, a.outcome) for a in res.report.attempted] == [("fitted", "matched")]
    assert res.report.attempted[0].error is None


def test_report_serializes_attempted_as_plain_dicts():
    # Backward-compatible JSON: `attempted` is an additive list of plain dicts (asdict), so
    # older clients simply ignore the new key.
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    d = reconstruct(glb, "glb", method="auto").to_dict()
    assert d["report"]["attempted"][0] == {
        "route": "single_primitive",
        "outcome": "no_match",
        "error": None,
    }


def test_report_face_type_breakdown_cylinder_counts_curved():
    # FR-9 / §6: an analytic cylinder (auto) reports curved + planar caps, no faceted faces,
    # and the per-type counts sum to faces_built (the breakdown the honest-UX NFR-4 needs).
    glb = trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48).export(file_type="glb")
    r = reconstruct(glb, "glb", method="auto").report
    assert r.primitive == "cylinder"
    assert r.curved_faces >= 1  # the lateral cylindrical face
    assert r.planar_faces == 2  # the two circular caps
    assert r.faceted_faces == 0  # nothing fell back to per-triangle
    assert r.planar_faces + r.curved_faces + r.freeform_faces == r.faces_built


def test_reconstruct_isolated_matches_inprocess():
    """The crash-isolated spawn path returns the SAME wire dict as the in-process reconstruct.

    A very large organic mesh can OOM/crash inside OCCT; running the build in a thread would take the
    whole service process down. The isolated path runs it in a spawn child instead — this asserts that
    isolation is transparent for a normal mesh (same STEP + report), so it is safe to always use."""
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    inproc = reconstruct(glb, "glb", method="faceted").to_dict()
    isolated = reconstruct_isolated(glb, "glb", method="faceted")
    assert isolated["report"]["method"] == inproc["report"]["method"] == "faceted"
    assert isolated["report"]["is_valid"] == inproc["report"]["is_valid"]
    assert isolated["report"]["is_solid"] == inproc["report"]["is_solid"]
    assert isolated["step"].startswith("ISO-10303-21")
    assert "END-ISO-10303-21" in isolated["step"]


def test_reconstruct_isolated_worker_failure_degrades_not_crashes():
    """A failure inside the isolated worker surfaces as a catchable IsolatedWorkerError — the caller
    process survives. This is the graceful-degradation contract: an OOM/native crash on a pathological
    mesh fails THAT job (HTTP 500) instead of SIGKILLing the service. Here an invalid GLB makes the
    worker raise; the abnormal-death (SIGKILL) flavor is covered by the occ_pool unit tests."""
    with pytest.raises(IsolatedWorkerError):
        reconstruct_isolated(b"this is not a valid GLB payload", "glb")
