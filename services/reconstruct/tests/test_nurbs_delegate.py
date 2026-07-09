"""U10 / SPEC-12 FR-10 — env-gated delegation of a freeform region to the nurbs service.

Both directions are proven WITHOUT a live server, by injecting an httpx.Client-shaped fake:

* ``RECONSTRUCT_NURBS_URL`` **unset** ⇒ ``delegate_region_face`` returns None immediately (no HTTP),
  and ``freeform_region_face`` builds the region locally via ``BRepOffsetAPI_MakeFilling`` — the
  existing path, byte-for-byte (asserted: the injected client is never touched).
* **set** + a fake returning a valid §6.1 result ⇒ ``delegate_region_face`` returns a real
  ``TopoDS_Face`` whose boundary coincides with the region polyline (so it sews), and the
  ``freeform_region_face`` hook returns that delegated face.
* **set** + a fake that is unreachable / HTTP-errors / reports a failed job ⇒ ``delegate_region_face``
  returns None (never raises), and ``freeform_region_face`` falls back to ``MakeFilling`` — i.e. the
  unset behaviour.

The fake returns real ``httpx.Response`` objects, so ``.status_code`` / ``.json()`` /
``.raise_for_status()`` behave exactly as against the live service. Delegation reads the returned
STEP (``STEPControl_Reader``) for the fitted *surface* and re-trims it with the region's OWN mesh
polyline (one straight 3D edge per segment + a p-curve on the surface), so the delegated face's
boundary edges are byte-identical to a faceted neighbour's — it sews edge-for-edge (SPEC-7 §D-3,
closed U10.2). The test STEP is a real OCCT face serialized with ``app.occ_step.shape_to_step`` —
for the open-region case built FROM that region's boundary polyline, so its surface interpolates the
rim and the re-trimmed face passes through it.
"""

import numpy as np
import pytest
import trimesh
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.TopoDS import TopoDS_Face

from app.freeform import face_max_point_error, freeform_face, freeform_region_face
from app.nurbs_delegate import delegate_region_face
from app.occ_step import shape_to_step

ENV = "RECONSTRUCT_NURBS_URL"


# --------------------------------------------------------------------------------------------------
# httpx.Client-shaped test double (the reconstruct-side analogue of @plastiq/nurbs's fetchImpl)
# --------------------------------------------------------------------------------------------------
def _resp(status_code: int, payload: dict):
    """A real httpx.Response — has .status_code / .json() / .raise_for_status() like the live wire."""
    import httpx

    return httpx.Response(status_code, json=payload, request=httpx.Request("GET", "http://nurbs.test/x"))


class _FakeClient:
    """Canned submit/status/result responses + optional raise-on-post, recording every call."""

    def __init__(self, *, submit=None, status=None, result=None, raise_on_post=None):
        self._submit = submit
        self._status = status
        self._result = result
        self._raise_on_post = raise_on_post
        self.calls: list[tuple[str, str]] = []
        self.closed = False

    def post(self, url, json=None):
        self.calls.append(("POST", url))
        if self._raise_on_post is not None:
            raise self._raise_on_post
        return self._submit

    def get(self, url):
        self.calls.append(("GET", url))
        if url.endswith("/status"):
            return self._status
        if url.endswith("/result"):
            return self._result
        raise AssertionError(f"unexpected GET {url}")

    def close(self):
        self.closed = True


def _surfaces_json() -> list[dict]:
    """A minimal but §6.2-shaped surface list (a clamped degree-1 bilinear patch). Delegation only
    checks ``surfaces`` is present; the face comes from the STEP — this is the faithful companion."""
    return [
        {
            "poles": [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]]],
            "weights": [],
            "u_knots": [0.0, 1.0],
            "v_knots": [0.0, 1.0],
            "u_mults": [2, 2],
            "v_mults": [2, 2],
            "u_degree": 1,
            "v_degree": 1,
            "u_periodic": False,
            "v_periodic": False,
        }
    ]


def _happy_client(step_text: str) -> _FakeClient:
    """Submit → status 'completed' → result {step, surfaces, report} — the success path."""
    return _FakeClient(
        submit=_resp(200, {"id": "job-1", "state": "queued"}),
        status=_resp(200, {"id": "job-1", "state": "completed"}),
        result=_resp(200, {"step": step_text, "surfaces": _surfaces_json(), "report": {"mode": "open"}}),
    )


# --------------------------------------------------------------------------------------------------
# Fixtures / STEP builders (real OCCT faces serialized as the service would return them)
# --------------------------------------------------------------------------------------------------
def _sphere_cap():
    """An OPEN curved region: the upper cap of an icosphere (a single boundary loop)."""
    m = trimesh.creation.icosphere(subdivisions=3, radius=0.02)
    cap_idx = np.nonzero(m.triangles_center[:, 2] > 0.012)[0]
    assert cap_idx.size > 10
    return m, cap_idx


def _step_from_region(mesh: trimesh.Trimesh, idx: np.ndarray) -> str:
    """STEP for a face whose rim IS the region's boundary polyline (mimics the nurbs FR-3 fit that
    interpolates the boundary), so the round-tripped face sews with the region's neighbours. Built
    hermetically (no hook/env) via freeform_face with an interior-count ladder — MakeFilling is not
    monotonically robust across interior counts (see freeform.py), so step down until one builds."""
    rim = np.asarray(mesh.outline(idx).discrete[0], dtype=float)
    boundary = rim[:-1] if (len(rim) >= 2 and np.allclose(rim[0], rim[-1])) else rim
    region_v = mesh.vertices[np.unique(mesh.faces[idx])]
    bset = {tuple(np.round(p, 7)) for p in boundary}
    interior = np.array([v for v in region_v if tuple(np.round(v, 7)) not in bset], dtype=float)
    for k in (50, 25, 10, 0):
        sub = None if k == 0 else (interior if len(interior) <= k else interior[:: max(1, len(interior) // k)][:k])
        face = freeform_face(boundary, sub)
        if face is not None:
            return shape_to_step(face)
    raise AssertionError("could not build a test STEP face for the region")


def _simple_face_step() -> str:
    """STEP for a small valid dome face — a canned 'fitted patch' for the closed-region case where
    the region itself has no boundary polyline to build one from."""
    boundary = np.array([[0, 0, 0], [0.02, 0, 0], [0.02, 0.02, 0], [0, 0.02, 0]], dtype=float)
    apex = np.array([[0.01, 0.01, 0.004]])
    face = freeform_face(boundary, apex)
    assert face is not None
    return shape_to_step(face)


# --------------------------------------------------------------------------------------------------
# 1. Unset env ⇒ no-op: no HTTP, and the freeform stage uses the existing MakeFilling path.
# --------------------------------------------------------------------------------------------------
def test_unset_env_delegate_returns_none_without_touching_client(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)
    m, cap_idx = _sphere_cap()
    fake = _happy_client(_simple_face_step())  # would succeed IF it were ever called
    assert delegate_region_face(m, cap_idx, fetch=fake) is None
    assert fake.calls == []  # env unset ⇒ zero HTTP


def test_unset_env_freeform_region_uses_makefilling(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)
    m, cap_idx = _sphere_cap()
    face = freeform_region_face(m, cap_idx)  # the existing local path
    assert face is not None
    rim = np.asarray(m.outline(cap_idx).discrete[0])
    assert face_max_point_error(face, rim) < 2e-4  # local MakeFilling face, rim respected


# --------------------------------------------------------------------------------------------------
# 2. Set env + valid result ⇒ a real face whose boundary coincides (sews); the hook returns it.
# --------------------------------------------------------------------------------------------------
def test_set_env_delegate_returns_valid_sewable_face(monkeypatch):
    monkeypatch.setenv(ENV, "http://nurbs.test/")
    m, cap_idx = _sphere_cap()
    fake = _happy_client(_step_from_region(m, cap_idx))
    face = delegate_region_face(m, cap_idx, fetch=fake)
    assert face is not None
    assert isinstance(face, TopoDS_Face)
    assert BRepCheck_Analyzer(face).IsValid()
    rim = np.asarray(m.outline(cap_idx).discrete[0])
    assert face_max_point_error(face, rim) < 2e-4  # rim coincides with the region polyline → sews
    # the full submit → poll → result round-trip actually ran
    assert ("POST", "http://nurbs.test/fit") in fake.calls
    assert any(u.endswith("/status") for _, u in fake.calls)
    assert any(u.endswith("/result") for _, u in fake.calls)


def test_set_env_freeform_region_returns_delegated_face(monkeypatch):
    # An OPEN region. Since the delegated face now shares the region's mesh polyline as its boundary
    # (one straight edge per segment — the sew fix), it is topologically identical to the local
    # MakeFilling face, so we can no longer tell them apart by edge count. Instead we NEUTRALISE the
    # local builder (force `freeform_face` to decline): a non-None result can then ONLY have come from
    # delegation, unambiguously proving the hook returns the delegated face.
    import app.freeform as freeform_mod

    m, cap_idx = _sphere_cap()
    step = _step_from_region(m, cap_idx)  # build the STEP BEFORE neutralising the local builder
    monkeypatch.setattr(freeform_mod, "freeform_face", lambda *a, **k: None)  # local path now declines

    monkeypatch.delenv(ENV, raising=False)
    assert freeform_region_face(m, cap_idx) is None  # baseline: no delegation + local declines → None

    fake = _happy_client(step)
    monkeypatch.setenv(ENV, "http://nurbs.test")
    import httpx

    monkeypatch.setattr(httpx, "Client", lambda **kw: fake)  # the hook builds its own client
    face = freeform_region_face(m, cap_idx)
    assert face is not None  # ONLY delegation could produce this (the local builder is neutralised)
    assert BRepCheck_Analyzer(face).IsValid()
    assert any(u.endswith("/fit") for _, u in fake.calls)  # delegation genuinely ran
    assert fake.closed  # the client delegation created was closed


# --------------------------------------------------------------------------------------------------
# 3./4. Set env + a failing service ⇒ None (never raises); the freeform stage falls back to
#        MakeFilling — byte-for-byte the unset behaviour.
# --------------------------------------------------------------------------------------------------
def _unreachable_client() -> _FakeClient:
    import httpx

    return _FakeClient(raise_on_post=httpx.ConnectError("connection refused"))


def _http_error_client() -> _FakeClient:
    return _FakeClient(submit=_resp(500, {"detail": "internal error"}))


def _failed_job_client() -> _FakeClient:
    return _FakeClient(
        submit=_resp(200, {"id": "job-9", "state": "queued"}),
        status=_resp(200, {"id": "job-9", "state": "failed", "error": "genus >= 1 rejected"}),
    )


@pytest.mark.parametrize(
    "factory", [_unreachable_client, _http_error_client, _failed_job_client],
    ids=["unreachable", "http-error", "failed-job"],
)
def test_delegation_failure_returns_none_and_never_raises(monkeypatch, factory):
    monkeypatch.setenv(ENV, "http://nurbs.test")
    m, cap_idx = _sphere_cap()
    # delegate swallows every failure mode and returns None (no exception escapes)
    assert delegate_region_face(m, cap_idx, fetch=factory()) is None


@pytest.mark.parametrize(
    "factory", [_unreachable_client, _http_error_client, _failed_job_client],
    ids=["unreachable", "http-error", "failed-job"],
)
def test_freeform_region_falls_back_to_makefilling_on_failure(monkeypatch, factory):
    monkeypatch.setenv(ENV, "http://nurbs.test")
    import httpx

    monkeypatch.setattr(httpx, "Client", lambda **kw: factory())
    m, cap_idx = _sphere_cap()
    face = freeform_region_face(m, cap_idx)
    # identical to the unset path: a valid local MakeFilling face whose rim is respected
    assert face is not None
    rim = np.asarray(m.outline(cap_idx).discrete[0])
    assert face_max_point_error(face, rim) < 2e-4
