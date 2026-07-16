"""FR-5 faceted fallback: per-triangle planar OCC faces + a mixed NURBS/faceted solid assembly.

SPEC-12 FR-5/FR-8 (U7.4): a NURBS patch that misses ``fidelity_tol`` (or whose fit/schema
fails) is not dropped — it is replaced by the **per-triangle planar faces** of its mesh region,
and the whole solid is assembled from the mix (fitted NURBS patches + faceted regions). The
service therefore ALWAYS returns a valid B-rep STEP: an all-faceted extreme reproduces the input
mesh's triangles exactly (a watertight solid, the honest reconstruct D-5/FR-8 baseline), and a
partial mix is an honest open shell whose closure is **verified, never assumed** (FR-4).

The pattern mirrors ``services/reconstruct/app/faceted.py`` (per-triangle ``MakePolygon`` →
``MakeFace``); the mixed sew → ``MakeSolid`` → ``OrientClosedSolid`` → verify closure step is
**shared, not duplicated** — :func:`_assemble_faces` calls ``occ_step.assemble_verified_solid``,
the SAME single copy of the closure-verification chain the pure-NURBS GATE
(``occ_step.surfaces_to_solid_step``) uses, so the safety-critical "never fabricate a solid"
logic cannot drift between the two modules.

**OCC placement (the design decision, documented per the two options in U7.4).** The
face-building OCCT (``faceted_faces`` per-triangle planar faces, :func:`sew_faces`) lives in
*this* module and runs behind :func:`app.occ_pool.run_isolated` via the module-level
:func:`mixed_solid_worker` — the SAME crash-isolation contract as :mod:`app.occ_step` (a native
segfault is a failed job, never a dead service, SPEC-12 §7). The closure-verification chain and
the NURBS surface construction are BOTH imported from ``occ_step`` (``assemble_verified_solid``
and ``build_bspline_surface``, its public seams), so neither is duplicated — the only OCCT unique
to this module is the faceted per-triangle build. The one intentional divergence from the shared
chain is the FR-8 tail in :func:`_assemble_faces`: for a non-solid result it re-reports the sewn
shape's OWN validity (an open shell / compound is a valid B-rep in its own right).

Deterministic throughout (fixed payload/region order, deterministic sew — no RNG, NFR-1).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_Sewing,
)
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.gp import gp_Pnt
from OCC.Core.TopoDS import TopoDS_Face, TopoDS_Shape

from . import occ_step
from .occ_pool import run_isolated
from .schema import NurbsSurface, Surfaces

__all__ = [
    "FacetedRegion",
    "assemble_mixed_solid",
    "faceted_faces",
    "mixed_solid_worker",
    "sew_faces",
]

# Sew/face tolerances: identical to occ_step's, so a mixed assembly stitches on the same 1e-6
# scale the pure-NURBS GATE uses (U7.2 makes NURBS seams coincident to << 1e-6; faceted regions
# reuse the raw mesh vertices, which are shared bitwise between charts).
_SEW_TOLERANCE = 1e-6
_FACE_TOLERANCE = 1e-6
# (2*area)^2 floor below which a triangle is a degenerate sliver that can build no face.
_AREA2_TOL = 1e-20


@dataclass(frozen=True)
class FacetedRegion:
    """One mesh region to facet: its own vertices and local-index triangles.

    ``vertices`` is ``(m, 3)`` float; ``triangles`` is ``(k, 3)`` int indices into
    ``vertices``. Both are plain numpy (picklable), so a region crosses the spawn boundary
    into :func:`mixed_solid_worker` intact. In closed mode a region is one cube-map chart's
    submesh (its ``vertex_map`` vertices + its faces re-indexed local), so its faceted faces
    reuse the exact mesh coordinates the neighbouring charts share.
    """

    vertices: np.ndarray
    triangles: np.ndarray


def faceted_faces(vertices, triangles) -> list[TopoDS_Face]:
    """A mesh region's triangles → one planar OCC face each (FR-5 per-triangle build).

    Every non-degenerate triangle becomes a closed 3-point polygon wire → planar
    :class:`BRepBuilderAPI_MakeFace` face, coordinates used as-is (SI metres — the STEP I/O
    convention, so the faces round-trip through ``importStep``). Degenerate slivers (zero area,
    or a polygon/face OCCT refuses to build) are skipped, never crashed.

    Args:
        vertices: ``(m, 3)`` region vertices (float array-like).
        triangles: ``(k, 3)`` triangle vertex indices into ``vertices``.

    Returns:
        the built faces, one per surviving triangle, in input order.

    Raises:
        ValueError: not one triangle could be built (an all-degenerate region) — an honest
            error rather than a silently empty B-rep.
    """
    verts = np.asarray(vertices, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64)
    if tris.ndim != 2 or tris.shape[-1] != 3:
        raise ValueError(f"triangles must be (k, 3) (got shape {tuple(tris.shape)})")

    faces: list[TopoDS_Face] = []
    for tri in tris:
        v0, v1, v2 = verts[tri[0]], verts[tri[1]], verts[tri[2]]
        cross = np.cross(v1 - v0, v2 - v0)
        if float(cross @ cross) <= _AREA2_TOL:  # (2*area)^2 — skip zero-area slivers
            continue
        polygon = BRepBuilderAPI_MakePolygon(
            gp_Pnt(float(v0[0]), float(v0[1]), float(v0[2])),
            gp_Pnt(float(v1[0]), float(v1[1]), float(v1[2])),
            gp_Pnt(float(v2[0]), float(v2[1]), float(v2[2])),
            True,  # close the wire
        )
        if not polygon.IsDone():
            continue
        face_maker = BRepBuilderAPI_MakeFace(polygon.Wire(), True)
        if not face_maker.IsDone():
            continue
        faces.append(face_maker.Face())

    if not faces:
        raise ValueError("no valid triangles to build faceted B-rep faces from")
    return faces


def sew_faces(faces: list[TopoDS_Face], tol: float = _SEW_TOLERANCE) -> tuple[TopoDS_Shape, int]:
    """Sew a list of faces (NURBS and/or faceted) into a shell; return ``(shape, free_edges)``.

    The single mixed-sew step shared by the assembly and by the unit tests: all faces go into
    one ``BRepBuilderAPI_Sewing(tol)`` pass so coincident edges (whether between two faceted
    triangles or a faceted edge and a NURBS rim) merge together. ``free_edges`` is the sewing's
    naked-edge tally (``0`` ⇔ every edge is shared by two faces ⇔ the shell is closed).

    Raises:
        ValueError: an empty face list — nothing to sew.
    """
    if not faces:
        raise ValueError("sew_faces requires at least one face")
    sewing = BRepBuilderAPI_Sewing(tol)
    for face in faces:
        sewing.Add(face)
    sewing.Perform()
    return sewing.SewedShape(), int(sewing.NbFreeEdges())


def _assemble_faces(faces: list[TopoDS_Face]) -> dict:
    """Sew a mix of faces → shell → solid attempt → verified closure → STEP text.

    Sews all faces (:func:`sew_faces`), then runs the shared closure chain
    :func:`app.occ_step.assemble_verified_solid` (``MakeSolid`` + outward
    ``breplib.OrientClosedSolid`` + verify — the SAME single copy the pure-NURBS GATE uses, so
    the "never fabricate a solid" logic cannot drift between the two modules). Closure is
    verified, never assumed — ``is_solid`` is ``True`` only when a single shell sewed shut
    (``free_edges == 0``) and ``MakeSolid`` accepted it.

    A partial mix whose NURBS/faceted seam cannot merge stays an honest open shell (``is_solid
    == False``) whose STEP still serializes and re-imports (FR-8). ``occ_step``'s chain leaves
    ``is_valid`` ``False`` for a non-solid result (it only verifies the solid it built); the
    faceted fallback instead surfaces the sewn shape's OWN validity, because an open shell /
    compound is a valid B-rep in its own right (FR-8).

    Returns:
        ``{"step", "faces", "is_solid", "is_valid", "free_edges", "volume"}``.
    """
    sewed, free_edges = sew_faces(faces)
    result = occ_step.assemble_verified_solid(sewed, free_edges)
    if not result["is_solid"]:
        # An open shell / compound is a valid B-rep too (FR-8) — report its real validity.
        result["is_valid"] = bool(BRepCheck_Analyzer(sewed).IsValid())
    return result


def mixed_solid_worker(surfaces_payload: dict, faceted_regions: list[FacetedRegion]) -> dict:
    """Spawn-pool worker: fitted NURBS surfaces JSON + faceted regions → assembled solid report.

    Module-level by contract — :func:`app.occ_pool.run_isolated` pickles it by reference and the
    fresh child re-imports it (and this module's OCC + ``occ_step``). Builds a natural-bounds face
    for each validated NURBS surface (via ``occ_step.build_bspline_surface`` — the belt-and-braces
    re-validation :mod:`app.occ_step` also does), then one planar face per triangle of each
    faceted region, and assembles the whole mix with :func:`_assemble_faces`. Every returned field
    is picklable, so a native OCCT crash during assembly is a failed job, never a dead service.
    """
    faces: list[TopoDS_Face] = []
    for surface in surfaces_payload.get("surfaces", []):
        model = NurbsSurface.model_validate(surface)
        faces.append(
            BRepBuilderAPI_MakeFace(occ_step.build_bspline_surface(model), _FACE_TOLERANCE).Face()
        )
    for region in faceted_regions:
        faces.extend(faceted_faces(region.vertices, region.triangles))
    return _assemble_faces(faces)


def assemble_mixed_solid(
    surfaces_payload: dict,
    faceted_regions: list[FacetedRegion],
    *,
    timeout: float | None = None,
) -> dict:
    """Crash-isolated mixed assembly seam (mirrors ``occ_step.surfaces_json_to_solid_step``).

    Validates the fitted NURBS surfaces FIRST when any are present (FR-6: a schema-invalid
    payload raises pydantic ``ValidationError`` with NO subprocess spawned), then runs
    :func:`mixed_solid_worker` in a fresh spawn process via :func:`app.occ_pool.run_isolated`, so
    native OCCT crashes/hangs surface as :class:`app.occ_pool.IsolatedWorkerError`. An empty
    surface list (the all-faceted extreme) skips schema validation and assembles the regions
    alone — the FR-8 guarantee that even all-faceted returns a valid STEP.

    Returns:
        the :func:`_assemble_faces` dict — ``{"step", "faces", "is_solid", "is_valid",
        "free_edges", "volume"}``.
    """
    if surfaces_payload.get("surfaces"):
        Surfaces.model_validate(surfaces_payload)
    return run_isolated(mixed_solid_worker, surfaces_payload, faceted_regions, timeout=timeout)
