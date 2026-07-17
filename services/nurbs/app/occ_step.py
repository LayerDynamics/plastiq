"""Validated NURBS-surface JSON → OCCT ``Geom_BSplineSurface`` → faces → STEP text.

SPEC-12 §5.2 ``occ_step.py`` row (U6.1): the only module that touches OCCT geometry.
Every public conversion is meant to run behind :func:`app.occ_pool.run_isolated`
(§7: OCCT is native code — a segfault must be a failed job, never a dead service),
so :func:`step_worker` is a **module-level** callable the spawn child can re-import.

Knot handoff (§6.2 invariant 5, D-7): the wire carries **compact** knots (unique
strictly-increasing values + parallel multiplicities) — exactly the form OCCT's
``Geom_BSplineSurface`` constructor consumes, so this module passes them through
DIRECTLY with no flattening. The flat/textbook expansion exists only for the MLX
core (``core/knots.py`` / ``NurbsSurface.flat_*_knots``).

Pole-grid orientation (the U7.3 sewing contract): schema ``poles`` is a
``num_u × num_v`` grid — ``poles[i][j]`` has u-index ``i`` and v-index ``j``,
matching ``core/eval.py``'s ``(nu, nv, 3)`` arrays. OCCT's ``Poles(i, j)`` uses the
FIRST index for u as well (``Poles.ColLength()`` — the number of rows — must equal
``sum(UMults) - UDegree - 1``), so the mapping is the direct 0→1-based shift
``poles[i][j] ⇒ Poles(i + 1, j + 1)`` with **no transpose**. The weights grid maps
identically.

STEP conventions (SPEC-7 D-4, mirrored by SPEC-12 and reconstruct's
``app/occ_step.py``): ``STEPControl_AsIs``, raw metre coordinates, OCCT's default
write unit — write to a temp file and read the text back.

Validation happens in :mod:`app.schema` BEFORE OCCT (FR-6): the public JSON seam
:func:`surfaces_json_to_step` re-raises pydantic ``ValidationError`` without
spawning a worker, and :func:`step_worker` re-validates inside the subprocess
(belt and braces — the worker never trusts its caller).
"""

from __future__ import annotations

import os
import tempfile

from OCC.Core.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
    BRepBuilderAPI_Transform,
)
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepGProp import brepgprop
from OCC.Core.BRepLib import breplib
from OCC.Core.Geom import Geom_BSplineSurface
from OCC.Core.gp import gp_Pnt, gp_Trsf
from OCC.Core.GProp import GProp_GProps
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCC.Core.TColgp import TColgp_Array2OfPnt
from OCC.Core.TColStd import (
    TColStd_Array1OfInteger,
    TColStd_Array1OfReal,
    TColStd_Array2OfReal,
)
from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_SHELL
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Shape, TopoDS_Shell, topods

from .occ_pool import run_isolated
from .schema import NurbsSurface, Surfaces

__all__ = [
    "assemble_verified_solid",
    "build_bspline_surface",
    "solid_step_worker",
    "step_worker",
    "surfaces_json_to_solid_step",
    "surfaces_json_to_step",
    "surfaces_to_solid_step",
    "surfaces_to_step",
]

# Sewing tolerance for multi-face shells (SPEC-12 plan U6.1; U7.2 makes patches
# watertight by construction, so this only stitches already-coincident edges).
_SEW_TOLERANCE = 1e-6
# BRepBuilderAPI_MakeFace degenerate-edge tolerance (natural-bounds face on the
# full surface — OCCT's Precision::Confusion() scale).
_FACE_TOLERANCE = 1e-6


def _real_array1(values: list[float]) -> TColStd_Array1OfReal:
    array = TColStd_Array1OfReal(1, len(values))
    for index, value in enumerate(values, start=1):
        array.SetValue(index, value)
    return array


def _int_array1(values: list[int]) -> TColStd_Array1OfInteger:
    array = TColStd_Array1OfInteger(1, len(values))
    for index, value in enumerate(values, start=1):
        array.SetValue(index, value)
    return array


def build_bspline_surface(surface: NurbsSurface) -> Geom_BSplineSurface:
    """Validated :class:`~app.schema.NurbsSurface` → OCCT ``Geom_BSplineSurface``.

    Compact knots + multiplicities go to OCCT directly (no flattening — §6.2
    invariant 5). Pole rows are the u direction: ``poles[i][j] ⇒ Poles(i+1, j+1)``
    (see the module docstring for why there is no transpose). ``weights == []``
    takes the non-rational constructor overload (all weights 1.0, D-8 default);
    both directions are non-periodic (v1 rejects periodic surfaces upstream).
    """
    nu, nv = surface.num_poles_u, surface.num_poles_v
    poles = TColgp_Array2OfPnt(1, nu, 1, nv)
    for i, row in enumerate(surface.poles, start=1):
        for j, (x, y, z) in enumerate(row, start=1):
            poles.SetValue(i, j, gp_Pnt(x, y, z))

    u_knots = _real_array1(surface.u_knots)
    v_knots = _real_array1(surface.v_knots)
    u_mults = _int_array1(surface.u_mults)
    v_mults = _int_array1(surface.v_mults)

    if surface.is_rational:
        weights = TColStd_Array2OfReal(1, nu, 1, nv)
        for i, row in enumerate(surface.weights, start=1):
            for j, weight in enumerate(row, start=1):
                weights.SetValue(i, j, weight)
        return Geom_BSplineSurface(
            poles, weights, u_knots, v_knots, u_mults, v_mults,
            surface.u_degree, surface.v_degree,
            surface.u_periodic, surface.v_periodic,
        )
    return Geom_BSplineSurface(
        poles, u_knots, v_knots, u_mults, v_mults,
        surface.u_degree, surface.v_degree,
        surface.u_periodic, surface.v_periodic,
    )


def _count_faces(shape: TopoDS_Shape) -> int:
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


#: Fitted surfaces are in SI metres; STEP declares millimetres (FablesFindings I1).
M_TO_MM = 1000.0


def _to_millimetres(shape: TopoDS_Shape) -> TopoDS_Shape:
    """Scale an SI-metre shape into millimetres (a copy; the input is untouched)."""
    trsf = gp_Trsf()
    trsf.SetScale(gp_Pnt(0.0, 0.0, 0.0), M_TO_MM)
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


def _shape_to_step(shape: TopoDS_Shape) -> str:
    """Serialize a shape to STEP text — reconstruct's convention (SPEC-7 D-4).

    ``STEPControl_AsIs``, coordinates scaled to MILLIMETRES so they agree with the
    unit OCCT declares; the writer only targets files, so write to a temp file and
    read the text back.

    This used to write RAW coordinates and lean on OCCT's default write unit. That
    only ever worked because the kernel's reader was wrong in the same direction:
    the shapes are SI metres, OCCT writes their raw numbers and DECLARES the file
    millimetre, so a 20 mm feature went out as "0.02 mm" — 1000x too small for
    every consumer except Plastiq. The kernel now converts at its own boundary
    (FablesFindings I1), so emitting raw SI here would read back 1000x too small.
    """
    writer = STEPControl_Writer()
    if writer.Transfer(_to_millimetres(shape), STEPControl_AsIs) != IFSelect_RetDone:
        raise RuntimeError("STEP transfer failed (OCCT status not RetDone)")
    fd, path = tempfile.mkstemp(suffix=".step")
    os.close(fd)
    try:
        if writer.Write(path) != IFSelect_RetDone:
            raise RuntimeError("STEP write failed (OCCT status not RetDone)")
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    finally:
        os.remove(path)


def surfaces_to_step(surfaces: Surfaces | list[NurbsSurface]) -> tuple[str, int]:
    """Validated surfaces → natural-bounds faces → (sewn) shape → STEP text.

    A single surface stays a lone face; multiple faces are stitched with
    ``BRepBuilderAPI_Sewing(1e-6)`` (disjoint faces simply share a compound).
    Solid-making is deliberately NOT attempted here — closure is U7's gate.

    Returns ``(step_text, face_count)`` with the face count taken from the final
    shape, not the input length.
    """
    models = surfaces.surfaces if isinstance(surfaces, Surfaces) else list(surfaces)
    if not models:
        raise ValueError("surfaces_to_step requires at least one surface")

    faces = [
        BRepBuilderAPI_MakeFace(build_bspline_surface(model), _FACE_TOLERANCE).Face()
        for model in models
    ]
    if len(faces) == 1:
        shape: TopoDS_Shape = faces[0]
    else:
        sewing = BRepBuilderAPI_Sewing(_SEW_TOLERANCE)
        for face in faces:
            sewing.Add(face)
        sewing.Perform()
        shape = sewing.SewedShape()
    return _shape_to_step(shape), _count_faces(shape)


def step_worker(surfaces_payload: dict) -> dict:
    """Spawn-pool worker: plain ``{"surfaces": [...]}`` dict → ``{"step", "faces"}``.

    Module-level by contract — :func:`app.occ_pool.run_isolated` pickles the
    callable by reference and the fresh child re-imports it. Re-validates the
    payload (belt and braces with :func:`surfaces_json_to_step`'s pre-spawn
    validation) so a worker reached through any path still never hands OCCT
    unvalidated data.
    """
    validated = Surfaces.model_validate(surfaces_payload)
    step_text, faces = surfaces_to_step(validated)
    return {"step": step_text, "faces": faces}


def surfaces_json_to_step(payload: dict, *, timeout: float | None = None) -> tuple[str, int]:
    """The pipeline seam (U6.3): JSON payload → crash-isolated OCCT → STEP text.

    Validates FIRST — a schema-invalid payload raises pydantic ``ValidationError``
    straight through and NO subprocess is spawned (FR-6: validation failures are
    cheap, specific job failures). Valid payloads convert inside a fresh spawn
    process via :func:`app.occ_pool.run_isolated`; native crashes and hangs
    surface as :class:`app.occ_pool.IsolatedWorkerError`.
    """
    Surfaces.model_validate(payload)
    result = run_isolated(step_worker, payload, timeout=timeout)
    return result["step"], result["faces"]


# ================================================================================================
# U7.3 — the watertight-solid assembly (the GATE): faces → sewn shell → MakeSolid → verify closure
# ================================================================================================


def _single_shell(shape: TopoDS_Shape) -> TopoDS_Shell | None:
    """The lone :class:`TopoDS_Shell` of ``shape``, or ``None`` if it is not exactly one.

    ``BRepBuilderAPI_Sewing`` returns a bare shell when the faces stitch into one connected
    surface, or a compound of several shells / loose faces when they do not. A watertight
    closed solid needs a **single** shell; a compound (disjoint pieces) is a closure failure
    the caller must surface honestly (``is_solid = False``), never wrap in a garbage solid.
    """
    if shape.ShapeType() == TopAbs_SHELL:
        return topods.Shell(shape)
    explorer = TopExp_Explorer(shape, TopAbs_SHELL)
    shells = []
    while explorer.More():
        shells.append(topods.Shell(explorer.Current()))
        explorer.Next()
    return shells[0] if len(shells) == 1 else None


def assemble_verified_solid(sewed: TopoDS_Shape, free_edges: int) -> dict:
    """Sewn shape + its free-edge tally → **watertight solid** → verify → STEP-text report (U7.3).

    The single copy of the closure-verification chain — the safety-critical "never fabricate a
    solid" logic that both the pure-NURBS GATE (:func:`surfaces_to_solid_step`) and the mixed
    NURBS/faceted assembly (:func:`app.faceted._assemble_faces`, via ``import``) run, so it lives
    in ONE place and cannot silently drift between the two. Given the ``sewed`` output of a
    ``BRepBuilderAPI_Sewing`` pass and its ``free_edges`` (``NbFreeEdges()``): if the faces
    stitched into a **single** shell (:func:`_single_shell`) that ``BRepBuilderAPI_MakeSolid``
    closes, the solid is oriented outward (``breplib.OrientClosedSolid``), then verified.

    Verification is **partial by design** and complete only for the fixed 6-patch cube-map
    topology this service builds: it checks the sewing ``free_edges == 0`` (every edge shared by
    two faces), ``BRepCheck_Analyzer.IsValid()``, and a ``GProp`` volume (positive ⇔ outward
    closed solid). It does NOT check ``NbMultipleEdges``/non-manifold junctions or global
    self-intersection — safe for the watertight-by-construction cube-map, but a caller feeding
    arbitrary surfaces must not read ``is_solid``/``is_valid`` as a full manifold-solid proof.

    ``is_solid`` is ``True`` only when a single shell sewed shut (``free_edges == 0``) and
    ``MakeSolid`` succeeded — the report never claims a solid it did not build. For a non-solid
    result ``is_valid`` is left ``False`` (no solid was verified); callers that treat an open
    shell as a valid B-rep in its own right (FR-8, :mod:`app.faceted`) re-check the sewn shape's
    own validity themselves. The STEP text serializes the **solid whenever MakeSolid succeeds,
    even if the shell is open** (``is_solid`` may still be ``False``); only when there is no
    single shell or ``MakeSolid`` fails does it fall back to the sewn shape — so a failed gate
    still emits inspectable geometry.

    Returns:
        ``{"step", "faces", "is_solid", "is_valid", "free_edges", "volume"}`` — ``faces`` the
        real OCCT face tally of the serialized shape, ``volume`` a float (metres³).
    """
    is_solid = False
    is_valid = False
    volume = 0.0
    shape_for_step: TopoDS_Shape = sewed

    shell = _single_shell(sewed)
    if shell is not None:
        maker = BRepBuilderAPI_MakeSolid(shell)
        if maker.IsDone():
            solid = maker.Solid()
            breplib.OrientClosedSolid(solid)  # flip inward-facing shells so volume > 0
            is_valid = bool(BRepCheck_Analyzer(solid).IsValid())
            props = GProp_GProps()
            brepgprop.VolumeProperties(solid, props)
            volume = float(props.Mass())
            # A closed solid ⇔ a single shell with no free edges that MakeSolid accepted.
            is_solid = free_edges == 0
            shape_for_step = solid

    return {
        "step": _shape_to_step(shape_for_step),
        "faces": _count_faces(shape_for_step),
        "is_solid": is_solid,
        "is_valid": is_valid,
        "free_edges": free_edges,
        "volume": volume,
    }


def surfaces_to_solid_step(surfaces: Surfaces | list[NurbsSurface]) -> dict:
    """Validated surfaces → faces → sewn shell → **watertight solid** → verify → STEP text (U7.3).

    The closed-mode counterpart of :func:`surfaces_to_step`, and the GATE the whole service
    exists to pass (SPEC-12 FR-4 / U7): each surface becomes a natural-bounds face, the faces
    are stitched with ``BRepBuilderAPI_Sewing(1e-6)`` (U7.2 made the shared rims coincident to
    ≪ 1e-6, so this only merges already-coincident edges — watertight *by construction*, not by
    tolerance), then the sewn shape and its free-edge tally go to
    :func:`assemble_verified_solid` (the shared closure chain: ``MakeSolid`` +
    ``OrientClosedSolid`` + verify).

    Closure is **verified, never assumed** (SPEC-12 FR-4, reconstruct FR-7): the reported
    ``free_edges`` is the sewing's free-edge tally (0 ⇔ every edge is shared by two faces ⇔ the
    shell is closed), ``is_valid`` is ``BRepCheck_Analyzer.IsValid()`` on the solid, and
    ``volume`` is the ``GProp`` volume *after* orientation (positive ⇔ outward-oriented closed
    solid). ``is_solid`` is ``True`` only when a single shell sewed shut (``free_edges == 0``)
    and ``MakeSolid`` succeeded — so the report never claims a solid it did not build.

    The verification is **complete only for this service's fixed 6-patch cube-map topology**:
    it covers ``free_edges == 0`` + ``IsValid()`` + a positive volume band, but does NOT check
    ``NbMultipleEdges``/non-manifold junctions or global self-intersection (see
    :func:`assemble_verified_solid`) — a caller feeding arbitrary surfaces should treat those as
    unchecked. The STEP text serializes the **solid whenever ``MakeSolid`` succeeds, even if the
    shell is open** (``is_solid`` may still be ``False``), else the sewn shape (so a failed gate
    still emits inspectable geometry).

    Returns:
        ``{"step", "faces", "is_solid", "is_valid", "free_edges", "volume"}`` — ``faces`` the
        real OCCT face tally of the serialized shape, ``volume`` a float (metres³).
    """
    models = surfaces.surfaces if isinstance(surfaces, Surfaces) else list(surfaces)
    if not models:
        raise ValueError("surfaces_to_solid_step requires at least one surface")

    faces = [
        BRepBuilderAPI_MakeFace(build_bspline_surface(model), _FACE_TOLERANCE).Face()
        for model in models
    ]
    sewing = BRepBuilderAPI_Sewing(_SEW_TOLERANCE)
    for face in faces:
        sewing.Add(face)
    sewing.Perform()
    sewed = sewing.SewedShape()
    free_edges = int(sewing.NbFreeEdges())
    return assemble_verified_solid(sewed, free_edges)


def solid_step_worker(surfaces_payload: dict) -> dict:
    """Spawn-pool worker for the solid assembly — module-level for spawn pickling.

    Mirrors :func:`step_worker` for the U7.3 GATE: re-validates the payload inside the fresh
    child (belt and braces — the worker never trusts its caller) then returns
    :func:`surfaces_to_solid_step`'s ``{"step", "faces", "is_solid", "is_valid", "free_edges",
    "volume"}`` dict. Every field is picklable, so ``occ_pool.run_isolated`` ships it back
    intact and a native OCCT crash during the assembly is a failed job, never a dead service.
    """
    validated = Surfaces.model_validate(surfaces_payload)
    return surfaces_to_solid_step(validated)


def surfaces_json_to_solid_step(payload: dict, *, timeout: float | None = None) -> dict:
    """The closed-mode pipeline seam (U7.3): JSON payload → crash-isolated OCCT → solid report.

    Like :func:`surfaces_json_to_step` but assembles a solid: validates FIRST (a schema-invalid
    payload raises pydantic ``ValidationError`` with NO subprocess spawned — FR-6), then runs
    :func:`solid_step_worker` in a fresh spawn process via :func:`app.occ_pool.run_isolated`, so
    native OCCT crashes/hangs surface as :class:`app.occ_pool.IsolatedWorkerError`.

    Returns:
        the :func:`surfaces_to_solid_step` dict — ``{"step", "faces", "is_solid", "is_valid",
        "free_edges", "volume"}``.
    """
    Surfaces.model_validate(payload)
    return run_isolated(solid_step_worker, payload, timeout=timeout)
