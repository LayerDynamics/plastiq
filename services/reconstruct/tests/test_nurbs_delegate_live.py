"""U10.2 / SPEC-12 FR-10 — LIVE cross-service integration: reconstruct's freeform stage really
delegates a curved region to a RUNNING nurbs service (:8003), fitting a real B-spline surface.

Unlike ``test_nurbs_delegate.py`` (which injects an httpx-shaped fake), this file drives the ACTUAL
nurbs service over HTTP. It is **keyed** and **CI-safe**: at import it probes ``GET {url}/health``
(``httpx``, 2 s timeout) and, if the service is unreachable, every live test is ``skipif``-skipped
cleanly — mirroring reconstruct's ``test_recognition.py`` fixture-availability skip precedent (a
missing prerequisite becomes a VISIBLE skip in the run summary, never a silent green pass, and never
a red failure on a machine without the service). ``httpx`` / ``OCC`` are ``importorskip``-guarded so
a slim env skips the whole module rather than erroring at collection.

To run live, start the service (its env lives under a non-``micromamba`` root, so ``-p <prefix>``,
not ``-n``)::

    cd services/nurbs && micromamba run -p <plastiq-nurbs-prefix> uvicorn app.main:app --port 8003
    cd services/reconstruct && micromamba run -p <plastiq-reconstruct-prefix> \
        python -m pytest tests/test_nurbs_delegate_live.py -q

Override the target with ``NURBS_LIVE_URL`` (default ``http://127.0.0.1:8003``).

What the live path PROVES (observed against the running service, deterministic — the delegation
POSTs ``iters=0`` = pure LSQ, no RNG):

* ``delegate_region_face`` returns a real, valid ``TopoDS_Face`` whose surface passes through the
  region's boundary polyline to < 1e-3 (observed ~1e-9) — the unambiguous proof that the live nurbs
  service fit the region and reconstruct rebuilt the face from the returned STEP surface.
* The ``freeform_region_face`` hook, with ``RECONSTRUCT_NURBS_URL`` set, returns a delegated face
  whose boundary is now the SAME mesh polyline the local ``MakeFilling`` fallback uses — one wire of
  **N** straight edges, one per mesh-rim segment. That edge-for-edge compatibility with the faceted
  neighbour is exactly WHY it sews (previously the delegated patch had a **4**-curve boundary that
  could not). To prove such an N-edge face genuinely came from delegation (topology alone no longer
  distinguishes it), the hook test neutralises the local builder, so a non-None result can only be
  delegation's.
* **SURVIVAL (SPEC-7 §D-3, closed U10.2).** With delegation enabled, the full ``fitted_shape``
  pipeline yields a VALID, watertight solid in which the delegated NURBS face SURVIVES sewing:
  ``freeform_faces > 0`` and ``free_edges == 0`` in the FINAL result. Observed on the domed-part
  fixture: ``is_solid=True, is_valid=True, freeform_faces=1, planar_faces=1, triangle_faces=0,
  free_edges=0``, solid volume within ~2.6% of the mesh (< the 5% gate).

**Closed finding (U10.2, was the U10.1 non-sew gap).** The delegated face is no longer the STEP
patch's rectangular 4-curve boundary. Reconstruct reuses the fitted NURBS *surface* but rebuilds the
boundary from the region's mesh polyline: one straight 3D edge per segment (byte-identical to the
faceted/planar neighbour's shared edges) carrying a p-curve on the surface. The two boundaries are
now edge-coincident, so ``_assemble`` sews them (``free_edges == 0``, ``freeform_faces >= 1``, a
closed solid) and ``fitted_shape`` keeps the freeform-enhanced solid — the delegated NURBS face
persists into the final part. This matches ``app/nurbs_delegate.py``'s docstring; the tests below
assert this SURVIVAL behaviour.
"""

import os

import numpy as np
import pytest

trimesh = pytest.importorskip("trimesh")
httpx = pytest.importorskip("httpx")
pytest.importorskip("OCC")  # pythonocc-core — reconstruct's B-rep kernel

from OCC.Core.BRepCheck import BRepCheck_Analyzer  # noqa: E402  (after importorskip guards)
from OCC.Core.TopAbs import TopAbs_EDGE, TopAbs_WIRE  # noqa: E402
from OCC.Core.TopExp import TopExp_Explorer  # noqa: E402
from OCC.Core.TopoDS import TopoDS_Face  # noqa: E402

from app.fitted import _assemble, _solid_volume, fitted_shape  # noqa: E402
from app.freeform import face_max_point_error, freeform_region_face  # noqa: E402
from app.nurbs_delegate import delegate_region_face  # noqa: E402
from app.segment import planar_segments  # noqa: E402

ENV = "RECONSTRUCT_NURBS_URL"
NURBS_URL = os.environ.get("NURBS_LIVE_URL", "http://127.0.0.1:8003").rstrip("/")
# A bounded per-fit budget so the live test can never hang (the fit itself is ~1 s; a stuck service
# surfaces as a TimeoutError → a real failure, never an indefinite block).
FIT_TIMEOUT = 60.0


def _service_up(url: str) -> bool:
    """True iff the nurbs service answers a healthy /health within a short timeout (probe only —
    never raises; an unreachable/erroring service just means 'skip the live tests')."""
    try:
        r = httpx.get(f"{url}/health", timeout=2.0)
        return r.status_code == 200 and r.json().get("service") == "plastiq-nurbs"
    except Exception:  # noqa: BLE001 — any failure ⇒ service considered down ⇒ clean skip
        return False


SERVICE_UP = _service_up(NURBS_URL)
live = pytest.mark.skipif(
    not SERVICE_UP,
    reason=(
        f"nurbs service not reachable at {NURBS_URL}; start it with "
        f"`uvicorn app.main:app --port 8003` (or set NURBS_LIVE_URL) to run the live tests"
    ),
)


# --------------------------------------------------------------------------------------------------
# Fixtures / helpers
# --------------------------------------------------------------------------------------------------
def _sphere_cap() -> tuple["trimesh.Trimesh", np.ndarray]:
    """An OPEN, single-boundary-loop curved region: the dense upper cap of an icosphere. Same fixture
    style as test_freeform's ``test_freeform_region_face_on_a_sphere_cap`` and test_nurbs_delegate's
    ``_sphere_cap`` — dense/uniform enough that the nurbs open-mode LSQ fit interpolates the rim
    tightly (so it passes reconstruct's accuracy gate)."""
    m = trimesh.creation.icosphere(subdivisions=3, radius=0.02)
    cap_idx = np.nonzero(m.triangles_center[:, 2] > 0.012)[0]
    assert cap_idx.size > 10
    return m, cap_idx


def _domed_part() -> "trimesh.Trimesh":
    """A watertight 'domed part': the dense icosphere cap (a smooth curved region) closed by a FLAT
    disk sharing its rim — the box+dome pattern of test_freeform's freeform-capped-solid tests, but
    watertight and dense enough that the delegated fit clears the accuracy gate. The flat base is a
    single planar facet, so the dome is isolated as ONE single-loop non-planar region (exactly the
    shape reconstruct routes to the freeform/delegation stage)."""
    m = trimesh.creation.icosphere(subdivisions=3, radius=0.02)
    keep = np.nonzero(m.triangles_center[:, 2] > 0.012)[0]
    cap = m.submesh([keep], append=True)
    cap.remove_unreferenced_vertices()
    loops = cap.outline().discrete
    assert len(loops) == 1, f"cap must be single-loop, got {len(loops)}"
    rim = np.asarray(loops[0], dtype=float)
    rim = rim[:-1] if np.allclose(rim[0], rim[-1]) else rim
    verts = np.asarray(cap.vertices, dtype=float)
    z_plane = float(rim[:, 2].min())

    def _vid(p: np.ndarray) -> int:
        return int(np.argmin(np.linalg.norm(cap.vertices - p, axis=1)))

    rim_ids = [_vid(p) for p in rim]
    for ri in rim_ids:  # flatten the rim ring onto z=z_plane so the closing disk is truly planar
        verts[ri, 2] = z_plane
    verts = [tuple(v) for v in verts]
    center = len(verts)
    verts.append((0.0, 0.0, z_plane))
    faces = [tuple(t) for t in cap.faces]
    n = len(rim_ids)
    for e in range(n):  # triangle fan → one flat disk closing the dome's rim
        faces.append((rim_ids[e], center, rim_ids[(e + 1) % n]))
    part = trimesh.Trimesh(vertices=np.array(verts, dtype=float), faces=np.array(faces, dtype=np.int64), process=True)
    assert part.is_watertight, "domed part fixture must be watertight"
    return part


def _boundary_polyline(mesh: "trimesh.Trimesh", face_indices: np.ndarray) -> np.ndarray:
    return np.asarray(mesh.outline(face_indices).discrete[0], dtype=float)


def _wire_edge_counts(face: TopoDS_Face) -> tuple[int, int]:
    """(#wires, #edges) of a face. Used to assert the delegated face is now EDGE-COMPATIBLE with the
    local MakeFilling face: one wire of N straight edges, one per mesh-rim segment (previously the
    delegated patch was a rectangular B-spline with a 4-edge boundary that could not sew)."""

    def _count(kind) -> int:
        n, exp = 0, TopExp_Explorer(face, kind)
        while exp.More():
            n += 1
            exp.Next()
        return n

    return _count(TopAbs_WIRE), _count(TopAbs_EDGE)


# --------------------------------------------------------------------------------------------------
# 1. LIVE — the unambiguous delegation proof: a real fitted face from the running service whose
#    surface passes through the region polyline (so it clears the accuracy gate and, at the region
#    level, IS the fitted freeform face for the curved patch).
# --------------------------------------------------------------------------------------------------
@live
def test_live_delegate_region_face_fits_a_real_boundary_coincident_face(monkeypatch):
    monkeypatch.setenv(ENV, NURBS_URL)
    m, cap_idx = _sphere_cap()

    face = delegate_region_face(m, cap_idx, timeout=FIT_TIMEOUT)

    assert face is not None, "live nurbs service returned no face (fit failed) — a real failure"
    assert isinstance(face, TopoDS_Face)
    assert BRepCheck_Analyzer(face).IsValid()
    # The fitted surface passes through the region's boundary polyline: the sew-critical accuracy
    # property (SPEC-12 FR-3). Observed ~7.8e-10; the 1e-3 bound is the accuracy-gate scale.
    rim = _boundary_polyline(m, cap_idx)
    assert face_max_point_error(face, rim) < 1e-3
    # And the interior of the cap is approximated well (this is what reconstruct's accuracy gate
    # checks before accepting the delegated face as the region's freeform surface).
    region_v = m.vertices[np.unique(m.faces[cap_idx])]
    assert face_max_point_error(face, region_v) < 1e-3


# --------------------------------------------------------------------------------------------------
# 2. LIVE — the freeform_region_face HOOK delegates end-to-end, and the delegated face is now
#    EDGE-COMPATIBLE with the local MakeFilling fallback (one straight edge per mesh-rim segment) —
#    the property that makes it sew. Since that makes the two topologically identical, we neutralise
#    the local builder to prove the returned N-edge face genuinely came from delegation.
# --------------------------------------------------------------------------------------------------
@live
def test_live_freeform_region_hook_returns_delegated_face_edge_compatible(monkeypatch):
    import app.freeform as freeform_mod

    m, cap_idx = _sphere_cap()
    n_segments = len(_boundary_polyline(m, cap_idx)) - 1  # closing point duplicated → segment count

    # env UNSET: the existing local path — a MakeFilling face with one straight edge per rim segment.
    monkeypatch.delenv(ENV, raising=False)
    local = freeform_region_face(m, cap_idx)
    assert local is not None and BRepCheck_Analyzer(local).IsValid()
    lw, le = _wire_edge_counts(local)
    assert lw == 1 and le == n_segments  # polyline boundary: one straight edge per mesh-rim segment

    # Neutralise the local builder so a non-None result can ONLY be the delegated face (the delegated
    # face is now topologically identical to the local one — same N-edge mesh-polyline boundary — so
    # edge count alone no longer distinguishes them).
    monkeypatch.setattr(freeform_mod, "freeform_face", lambda *a, **k: None)
    monkeypatch.delenv(ENV, raising=False)
    assert freeform_region_face(m, cap_idx) is None  # local neutralised → no local face

    # env SET: the hook delegates to the live service and returns THAT face — now a mesh-polyline
    # boundary (N straight edges, one per rim segment), byte-identical to the faceted neighbour's
    # edges, which is why it sews. Same wire/edge count as the local face proves edge-compatibility.
    monkeypatch.setenv(ENV, NURBS_URL)
    delegated = freeform_region_face(m, cap_idx)
    assert delegated is not None and BRepCheck_Analyzer(delegated).IsValid()  # only delegation could
    dw, de = _wire_edge_counts(delegated)
    assert dw == 1 and de == n_segments  # delegated face now shares the mesh-polyline boundary (sews)
    assert de == le, "delegated face is now edge-compatible with the local MakeFilling face"
    # Same sew-critical property as the direct call: the delegated surface still passes through the rim.
    assert face_max_point_error(delegated, _boundary_polyline(m, cap_idx)) < 1e-3


# --------------------------------------------------------------------------------------------------
# 3. LIVE — full pipeline SURVIVAL: with delegation ENABLED, fitted_shape yields a VALID watertight
#    solid in which the delegated NURBS face SURVIVES — freeform_faces > 0, free_edges == 0. The
#    mesh-polyline boundary sews edge-for-edge with the flat base, so fitted_shape keeps the
#    freeform-enhanced solid (it does NOT rebuild faceted). See the module docstring SURVIVAL note.
# --------------------------------------------------------------------------------------------------
@live
def test_live_fitted_pipeline_delegated_face_survives_into_solid(monkeypatch):
    monkeypatch.setenv(ENV, NURBS_URL)
    part = _domed_part()
    v = np.asarray(part.vertices, dtype=float)
    f = np.asarray(part.faces, dtype=np.int64)

    res = fitted_shape(v, f)

    # A valid, watertight solid with delegation on...
    assert res.is_solid and res.is_valid
    assert res.free_edges == 0
    # ...in which the delegated NURBS face SURVIVED sewing (the whole point of §D-3): the dome is one
    # freeform face, not rebuilt into triangles. Observed: freeform_faces=1, planar_faces=1, tri=0.
    assert res.freeform_faces > 0, "the delegated NURBS face must survive into the final solid"
    # Volume is preserved (the freeform stage never degrades the reconstructed part). Observed ~2.6%.
    mesh_vol = abs(float(part.volume))
    assert abs(_solid_volume(res.shape) - mesh_vol) / mesh_vol < 0.05


@live
def test_live_delegated_region_sews_into_solid_at_assembly(monkeypatch):
    """SURVIVAL at the assembly layer: the delegated freeform face is accepted by the accuracy gate,
    and because its boundary is the region's mesh polyline (edge-identical to the flat base's shared
    edges), ``_assemble`` sews it into a CLOSED solid (freeform_faces >= 1, free_edges == 0). This is
    the closed §D-3 gap; if it ever regresses, this test (and app/nurbs_delegate.py's docstring) must
    be updated together."""
    part = _domed_part()
    v = np.asarray(part.vertices, dtype=float)
    f = np.asarray(part.faces, dtype=np.int64)
    mesh, facets, leftover = planar_segments(v, f)
    diag = float(np.linalg.norm(mesh.bounds[1] - mesh.bounds[0]))
    accuracy_tol = max(diag * 0.01, 1e-6)

    # LOCAL: the dome is kept faceted here (its MakeFilling face sews as triangles) → a valid solid.
    monkeypatch.delenv(ENV, raising=False)
    local = _assemble(mesh, facets, leftover, 1e-6, True, accuracy_tol)
    assert local.is_solid

    # DELEGATED: the delegated freeform face is accepted by the accuracy gate and its mesh-polyline
    # boundary sews edge-for-edge with the flat base → a CLOSED solid with the freeform face present.
    monkeypatch.setenv(ENV, NURBS_URL)
    delegated = _assemble(mesh, facets, leftover, 1e-6, True, accuracy_tol)
    assert delegated.freeform_faces >= 1  # the curved region became a delegated freeform face
    assert delegated.free_edges == 0 and delegated.is_solid  # ...and it sewed into a closed solid


# --------------------------------------------------------------------------------------------------
# 4. FAST (no service, no skip) — with RECONSTRUCT_NURBS_URL UNSET the region builds via the local
#    MakeFilling fallback, unchanged. Documents the unset direction on EVERY run (CI stays green even
#    with no service), the reconstruct-suite invariant the delegation must never disturb.
# --------------------------------------------------------------------------------------------------
def test_unset_env_region_builds_via_makefilling(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)
    m, cap_idx = _sphere_cap()
    face = freeform_region_face(m, cap_idx)  # no HTTP: delegation is OFF when the env is unset
    assert face is not None and BRepCheck_Analyzer(face).IsValid()
    rim = _boundary_polyline(m, cap_idx)
    assert face_max_point_error(face, rim) < 2e-4  # local MakeFilling face, rim respected (sews)
    # Local boundary is the mesh polyline: one straight edge per rim segment (contrast delegation's 4).
    lw, le = _wire_edge_counts(face)
    assert lw == 1 and le == len(rim) - 1
