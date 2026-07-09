"""Env-gated delegation of a freeform region to the nurbs service (SPEC-12 FR-10 / U10).

When ``RECONSTRUCT_NURBS_URL`` is set, reconstruct's freeform stage can offload a single-loop
non-planar mesh region to the standalone MLX NURBS service (``services/nurbs``, :8003) instead of
building the patch locally with ``BRepOffsetAPI_MakeFilling``. The nurbs service fits a real
B-spline surface whose rim **interpolates the region's boundary polyline at its vertices**
(SPEC-12 FR-3) — verified live: the returned face passes through the region's rim points to ~1e-9.

**Mesh-polyline boundary → edge-sewable (SPEC-7 §D-3, closed 2026-07-05, live cross-service test).**
The delegated face is NOT the STEP patch's natural rectangular ``4-curve`` boundary — that is only
*point*-coincident with the rim and would leave free edges against a faceted/planar neighbour (whose
shared boundary is the mesh polyline's straight segments — e.g. 36 edges for a 37-point rim). Instead
we **reuse the fitted NURBS surface but rebuild the boundary from the region's mesh polyline**: one
straight 3D edge per polyline segment (byte-identical to the neighbour's shared triangle edges) each
carrying a p-curve on the fitted surface (the §4.3 p-curve route). The face's 3D boundary edges then
equal the neighbour's edges exactly, so ``BRepBuilderAPI_Sewing`` merges them edge-for-edge
(``NbFreeEdges()==0``) while the interior stays the fitted NURBS surface — delegation's actual value.
Because the fitted surface interpolates the rim vertices (nurbs FR-3, ~1e-9), each vertex projects
onto the surface at ~1e-9, so the per-edge p-curve tolerance stays tiny; the short straight mesh
segment differs from the surface's own arc between rim vertices only by the (second-order) per-segment
sagitta, which ``breplib.SameParameter``/``ShapeFix_Face`` absorb into the edge tolerance. Verified
live: with delegation ON, ``fitted_shape`` on a domed part yields a VALID watertight solid whose
``freeform_faces > 0`` (the delegated NURBS face genuinely survives sewing), ``free_edges == 0``.
Any failure (unbuildable wire/face, invalid analyzer result) still returns ``None`` ⇒ the caller's
``MakeFilling`` fallback (FR-8); ``RECONSTRUCT_NURBS_URL`` unset ⇒ zero HTTP, unchanged.

Wire contract (SPEC-12 §6.1): ``POST /fit {glb_base64, mode:"open", iters:0}`` (``iters=0`` = the
deterministic pure-LSQ fit, no gradient refine) → poll ``GET /jobs/{id}/status`` until
``completed``/``failed`` → ``GET /jobs/{id}/result`` → ``{step, surfaces, report}``.

**Surface — STEP-read, not JSON-build (chosen).** The result carries both STEP text (§6.1) *and*
the §6.2 ``surfaces`` JSON. We obtain the fitted ``Geom_Surface`` by writing the STEP text to a temp
file, reading it with ``STEPControl_Reader``, taking its first face, and pulling the surface off that
face with ``BRep_Tool.Surface`` (its natural rectangular bounds are then discarded — only the surface
is kept). Rationale: it is the least code, reuses OCCT's proven, already-round-tripped STEP reader
(the same kernel path ``@plastiq/cad``'s ``importStep`` uses on this service's own output), and gives
the exact fitted surface. The alternative (rebuild a ``Geom_BSplineSurface`` from ``surfaces[0]`` per
§6.2) would duplicate the nurbs service's compact-knot recipe
(``services/nurbs/app/occ_step.build_bspline_surface``) here — reconstruct cannot import that package
(separate conda env) — for no benefit. We therefore read the STEP for the surface and build the
boundary wire ourselves from the region's mesh polyline (see the mesh-polyline-boundary note above).

**Fail-safe.** ANY failure — env unset, submesh/export error, unreachable service, HTTP error,
failed job, timeout, empty ``step``/``surfaces``, unreadable STEP, no fitted surface, no single-loop
region boundary, an unbuildable/invalid mesh-polyline trimmed face — returns ``None`` and never
raises into the caller, so the freeform stage falls straight back to its existing ``MakeFilling``
path. ``RECONSTRUCT_NURBS_URL`` unset ⇒ zero HTTP, zero behaviour change.
"""

from __future__ import annotations

import base64
import logging
import os
import tempfile
import time
from typing import Any, Optional

import numpy as np
import trimesh
from OCC.Core.BRep import BRep_Builder, BRep_Tool
from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeVertex,
    BRepBuilderAPI_MakeWire,
)
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepLib import breplib
from OCC.Core.Geom2d import Geom2d_BSplineCurve
from OCC.Core.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCC.Core.gp import gp_Pnt, gp_Pnt2d
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.ShapeFix import ShapeFix_Face
from OCC.Core.STEPControl import STEPControl_Reader
from OCC.Core.TColgp import TColgp_Array1OfPnt2d
from OCC.Core.TColStd import TColStd_Array1OfInteger, TColStd_Array1OfReal
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopLoc import TopLoc_Location
from OCC.Core.TopoDS import TopoDS_Face, topods

logger = logging.getLogger(__name__)


def _nurbs_url() -> Optional[str]:
    """The nurbs service base URL from ``RECONSTRUCT_NURBS_URL`` (None/empty ⇒ delegation OFF)."""
    url = os.environ.get("RECONSTRUCT_NURBS_URL")
    return url.strip() if url and url.strip() else None


def _submesh_glb_base64(mesh: trimesh.Trimesh, face_indices: np.ndarray) -> str:
    """The region's triangles as a standalone GLB, base64-encoded. The submesh keeps the region's
    exact vertex coordinates (re-indexed to a compact set), so its single boundary loop IS the
    region's mesh polyline — which the nurbs fit interpolates (FR-3), keeping the returned rim
    coincident with the neighbours' shared edges (the sew invariant)."""
    faces = np.asarray(mesh.faces)[np.asarray(face_indices)]
    sub = trimesh.Trimesh(vertices=np.asarray(mesh.vertices, dtype=float), faces=faces, process=False)
    sub.remove_unreferenced_vertices()  # drop the vertices no region triangle uses; coords preserved
    glb = sub.export(file_type="glb")
    if isinstance(glb, str):  # trimesh may hand back str for some exporters; GLB is binary
        glb = glb.encode("utf-8")
    return base64.b64encode(glb).decode("ascii")


def _face_from_step(step_text: str) -> Optional[TopoDS_Face]:
    """First ``TopoDS_Face`` of a STEP document (the nurbs open-mode result is one fitted face).

    Writes the text to a temp file (``STEPControl_Reader`` reads files only) and reads it back with
    the same kernel path the app already trusts for this service's STEP. Returns ``None`` on any
    reader status that is not ``RetDone``/has no roots/no face."""
    fd, path = tempfile.mkstemp(suffix=".step")
    os.close(fd)
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(step_text)
        reader = STEPControl_Reader()
        if reader.ReadFile(path) != IFSelect_RetDone:
            return None
        if reader.TransferRoots() <= 0:
            return None
        shape = reader.OneShape()
    finally:
        os.remove(path)
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    return topods.Face(explorer.Current()) if explorer.More() else None


def _region_boundary_polyline(mesh: trimesh.Trimesh, face_indices: np.ndarray) -> Optional[np.ndarray]:
    """The region's single ORDERED outer boundary loop as 3D vertices — the EXACT mesh polyline the
    faceted/planar neighbour also uses (so the rebuilt boundary edges are byte-identical to theirs and
    sew). Built the SAME way ``freeform.freeform_region_face`` builds its local boundary
    (``mesh.outline(face_indices).discrete``), so the delegated and local boundaries are identical.

    Returns ``None`` for a closed region (no boundary loop), a holed region (multiple loops), a
    degenerate loop (< 3 points), or any outline failure — every such case ⇒ the caller falls back."""
    try:
        outline = mesh.outline(face_indices)
        # A CLOSED region has no boundary edges (`.discrete` would raise); treat it as a clean decline.
        loops = outline.discrete if len(outline.entities) > 0 else []
    except Exception as e:  # noqa: BLE001 — degenerate region ⇒ decline (caller falls back).
        logger.debug("nurbs delegation: region outline failed (%s: %s); declining", type(e).__name__, e)
        return None
    if loops is None or len(loops) != 1:
        return None  # closed (no loop) or holed (multi-loop) → decline
    loop = np.asarray(loops[0], dtype=float)
    boundary = loop[:-1] if (len(loop) >= 2 and np.allclose(loop[0], loop[-1])) else loop
    return boundary if len(boundary) >= 3 else None


def _pcurve_segment(uv0: tuple, uv1: tuple, first: float, last: float) -> Geom2d_BSplineCurve:
    """A degree-1 2-pole clamped B-spline in ``(u, v)`` parameter space from ``uv0`` to ``uv1``,
    parametrized on ``[first, last]`` — the 3D edge's own parameter range — so the p-curve is
    SameRange with the straight 3D curve (a precondition for ``breplib.SameParameter``)."""
    poles = TColgp_Array1OfPnt2d(1, 2)
    poles.SetValue(1, gp_Pnt2d(float(uv0[0]), float(uv0[1])))
    poles.SetValue(2, gp_Pnt2d(float(uv1[0]), float(uv1[1])))
    knots = TColStd_Array1OfReal(1, 2)
    knots.SetValue(1, float(first))
    knots.SetValue(2, float(last))
    mults = TColStd_Array1OfInteger(1, 2)
    mults.SetValue(1, 2)
    mults.SetValue(2, 2)
    return Geom2d_BSplineCurve(poles, knots, mults, 1)


def _delegated_trimmed_face(surface, boundary: np.ndarray) -> Optional[TopoDS_Face]:
    """Build the delegated freeform face: the fitted ``surface`` trimmed by the region's mesh polyline
    (SPEC-7 §4.3 p-curve route). Each polyline segment becomes ONE straight 3D edge between the exact
    mesh vertices (byte-identical to the faceted neighbour's shared edges, so they sew edge-for-edge)
    carrying a p-curve on the fitted surface; the interior stays the fitted NURBS surface. Returns
    ``None`` on any build/validity failure (caller falls back to ``MakeFilling``).

    Each boundary vertex is projected onto the surface for its ``(u, v)`` (the fit interpolates the
    rim to ~1e-9, so these land on the surface); ``breplib.SameParameter`` + ``ShapeFix_Face`` then
    reconcile the straight 3D segment with the surface's own arc between rim vertices (a small
    per-segment sagitta) into the edge tolerance."""
    pts = np.asarray(boundary, dtype=float)
    n = len(pts)
    if n < 3:
        return None
    # Project each rim vertex onto the fitted surface → (u, v). The fit interpolates the rim, so the
    # projection distance is ~1e-9; a failed projection (no nearest point) ⇒ decline.
    uv: list[tuple[float, float]] = []
    for p in pts:
        proj = GeomAPI_ProjectPointOnSurf(gp_Pnt(float(p[0]), float(p[1]), float(p[2])), surface)
        if proj.NbPoints() <= 0:
            return None
        u, v = proj.LowerDistanceParameters()
        uv.append((float(u), float(v)))
    # One shared vertex per rim point so the wire is cleanly closed (edge k → edge k+1 share a vertex).
    verts = [BRepBuilderAPI_MakeVertex(gp_Pnt(float(p[0]), float(p[1]), float(p[2]))).Vertex() for p in pts]
    builder = BRep_Builder()
    wire_maker = BRepBuilderAPI_MakeWire()
    for k in range(n):
        make_edge = BRepBuilderAPI_MakeEdge(verts[k], verts[(k + 1) % n])
        if not make_edge.IsDone():
            return None
        edge = make_edge.Edge()
        first, last = BRep_Tool.Range(edge)  # the straight 3D edge's own parameter range
        pcurve = _pcurve_segment(uv[k], uv[(k + 1) % n], first, last)
        builder.UpdateEdge(edge, pcurve, surface, TopLoc_Location(), 1e-7)
        wire_maker.Add(edge)
        if not wire_maker.IsDone():
            return None
    wire = wire_maker.Wire()
    make_face = BRepBuilderAPI_MakeFace(surface, wire)
    if not make_face.IsDone():
        return None
    face = make_face.Face()
    breplib.SameParameter(face, 1e-6, True)  # reconcile 3D-edge vs p-curve into the edge tolerance
    fixer = ShapeFix_Face(face)
    fixer.SetPrecision(1e-6)
    fixer.SetMaxTolerance(1e-3)
    fixer.Perform()
    fixer.FixOrientation()
    fixed = fixer.Face()
    if fixed is None or not BRepCheck_Analyzer(fixed).IsValid():
        return None
    return fixed


def _submit_and_poll(
    client: Any, base: str, glb_b64: str, *, timeout: float, poll_interval: float
) -> Optional[dict]:
    """Run the §6.1 submit→poll and return the completed ``result`` JSON (or ``None`` on a failed
    job / no id). Raises on HTTP errors and timeout — the caller's broad handler maps those to
    ``None`` (fall back to ``MakeFilling``)."""
    submit = client.post(f"{base}/fit", json={"glb_base64": glb_b64, "mode": "open", "iters": 0})
    submit.raise_for_status()
    job_id = submit.json().get("id")
    if not job_id:
        logger.warning("nurbs delegation: /fit returned no job id; falling back")
        return None
    deadline = time.monotonic() + timeout
    while True:
        status = client.get(f"{base}/jobs/{job_id}/status")
        status.raise_for_status()
        state = status.json().get("state")
        if state == "completed":
            result = client.get(f"{base}/jobs/{job_id}/result")
            result.raise_for_status()
            return result.json()
        if state == "failed":
            logger.warning(
                "nurbs delegation: job %s failed (%s); falling back",
                job_id,
                status.json().get("error"),
            )
            return None
        if time.monotonic() >= deadline:
            raise TimeoutError(f"nurbs fit did not complete within {timeout}s")
        time.sleep(poll_interval)


def delegate_region_face(
    mesh: trimesh.Trimesh,
    face_indices: np.ndarray,
    *,
    timeout: float = 60.0,
    fetch: Any = None,
    poll_interval: float = 0.1,
) -> Optional[TopoDS_Face]:
    """Fit a curved mesh region to a B-spline face via the nurbs service, or ``None`` on ANY failure.

    Returns ``None`` immediately (no HTTP) when ``RECONSTRUCT_NURBS_URL`` is unset. Otherwise builds
    a submesh GLB of the region, POSTs it to ``/fit`` (open mode, deterministic ``iters=0``), polls
    to completion, pulls the fitted ``Geom_Surface`` off the returned STEP, and re-trims it with the
    region's OWN mesh polyline — one straight 3D edge per segment (byte-identical to the neighbour's
    shared edges) carrying a p-curve on the fitted surface (see the module docstring). The delegated
    face's 3D boundary edges therefore equal the neighbour's edges exactly, so the caller sews it
    edge-for-edge like a local ``MakeFilling`` face, while the interior is the fitted NURBS surface.

    ``fetch`` (tests): an httpx-``Client``-shaped object (``.post(url, json=...)`` / ``.get(url)``
    returning responses with ``.status_code`` / ``.json()`` / ``.raise_for_status()``) that lets a
    test inject a fake HTTP client — the reconstruct-side analogue of ``@plastiq/nurbs``'s
    ``fetchImpl``. When ``None`` a real ``httpx.Client(timeout=timeout)`` is created and closed here.
    """
    base = _nurbs_url()
    if base is None:
        return None  # delegation OFF — the caller uses its existing MakeFilling path unchanged
    base = base.rstrip("/")

    client = fetch
    owns_client = fetch is None
    if owns_client:
        import httpx  # noqa: PLC0415 — only needed on the delegation path; keeps import cost off unset

        client = httpx.Client(timeout=timeout)
    try:
        glb_b64 = _submesh_glb_base64(mesh, face_indices)
        result = _submit_and_poll(client, base, glb_b64, timeout=timeout, poll_interval=poll_interval)
        if result is None:
            return None
        step_text = result.get("step")
        surfaces = result.get("surfaces")
        if not step_text or not surfaces:
            logger.warning("nurbs delegation: result missing step/surfaces; falling back")
            return None
        # STEP → fitted surface (its natural rectangular bounds are discarded — we keep only the
        # surface and re-trim it with the region's own mesh polyline so the boundary sews).
        step_face = _face_from_step(step_text)
        if step_face is None:
            logger.warning("nurbs delegation: STEP yielded no face; falling back")
            return None
        surface = BRep_Tool.Surface(step_face)
        if surface is None:
            logger.warning("nurbs delegation: STEP face has no surface; falling back")
            return None
        boundary = _region_boundary_polyline(mesh, face_indices)
        if boundary is None:
            logger.warning("nurbs delegation: region has no single-loop boundary; falling back")
            return None
        face = _delegated_trimmed_face(surface, boundary)
        if face is None:
            logger.warning("nurbs delegation: mesh-polyline trimmed face invalid; falling back")
            return None
        return face
    except Exception as e:  # noqa: BLE001 — delegation is best-effort; ANY failure falls back to
        # the caller's MakeFilling path (never propagate into reconstruction).
        logger.warning(
            "nurbs delegation failed (%s: %s); falling back to MakeFilling", type(e).__name__, e
        )
        return None
    finally:
        if owns_client:
            try:
                client.close()
            except Exception:  # noqa: BLE001 — closing a client must never mask the real result
                pass
