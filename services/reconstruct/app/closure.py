"""Shared closure verification for built B-rep shapes (SPEC-7 FR-7).

FR-7 requires closure be VERIFIED, never assumed — even for shapes that are "born closed"
(BRepPrimAPI primitives, `MakeRevol` sweeps): `BRepBuilderAPI_MakeSolid` does not validate
closure, `BRepCheck_Analyzer` alone does not count naked edges, and a mis-oriented shell
encloses negative volume. Every reconstruction route runs the same chain on its OUTPUT shape:

  1. free-edge count — OCCT's free-bounds analysis (`ShapeAnalysis_FreeBounds`), which
     correctly ignores seam edges (cylinder/sphere parameterisation) and degenerated edges
     (sphere/cone apex) that a naive edge→face incidence count would misreport;
  2. optional `breplib.OrientClosedSolid` — flip an inward-oriented closed solid outward so
     a mere winding artefact isn't misreported as "no volume" (only safe/meaningful on a
     closed TopoDS_Solid, so it is gated on step 1 finding zero free edges);
  3. `BRepCheck_Analyzer.IsValid()` — topological/geometric validity;
  4. enclosed volume — must be strictly positive for a real solid.

`is_solid` is the conjunction of all of these; `free_edges` is always the real computed
count, never a hardcoded 0.
"""

from __future__ import annotations

from dataclasses import dataclass

from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepGProp import brepgprop
from OCC.Core.BRepLib import breplib
from OCC.Core.GProp import GProp_GProps
from OCC.Core.ShapeAnalysis import ShapeAnalysis_FreeBounds
from OCC.Core.TopAbs import TopAbs_EDGE, TopAbs_SOLID
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopoDS import TopoDS_Shape, topods


@dataclass(frozen=True)
class ClosureReport:
    is_solid: bool  # is_valid AND free_edges == 0 AND volume > 0
    is_valid: bool  # BRepCheck_Analyzer.IsValid()
    free_edges: int  # real naked-edge count (free-bounds analysis), never assumed
    volume: float  # signed enclosed volume (≤ 0 for open/inward shells)


def count_free_edges(shape: TopoDS_Shape) -> int:
    """The real number of free (naked) edges of `shape` via OCCT's free-bounds analysis.
    A watertight shell/solid has 0; each hole contributes its boundary edges. Seam and
    degenerated edges of closed analytic faces are (correctly) not counted as free."""
    bounds = ShapeAnalysis_FreeBounds(shape)
    n = 0
    for compound in (bounds.GetClosedWires(), bounds.GetOpenWires()):
        exp = TopExp_Explorer(compound, TopAbs_EDGE)
        while exp.More():
            n += 1
            exp.Next()
    return n


def shape_volume(shape: TopoDS_Shape) -> float:
    """Signed enclosed volume of `shape` (negative when the shell is oriented inward)."""
    props = GProp_GProps()
    brepgprop.VolumeProperties(shape, props)
    return float(props.Mass())


def verify_closure(shape: TopoDS_Shape, *, orient: bool = False) -> tuple[TopoDS_Shape, ClosureReport]:
    """Run the full FR-7 verification chain on a built shape.

    Returns `(shape, report)` — the shape is re-oriented outward in place of the input when
    `orient=True` and it is a closed solid (otherwise it is returned untouched), so callers
    must keep using the returned shape."""
    free = count_free_edges(shape)
    if orient and free == 0 and shape.ShapeType() == TopAbs_SOLID:
        solid = topods.Solid(shape)
        breplib.OrientClosedSolid(solid)
        shape = solid
    valid = bool(BRepCheck_Analyzer(shape).IsValid())
    volume = shape_volume(shape)
    is_solid = bool(valid and free == 0 and volume > 0)
    return shape, ClosureReport(is_solid=is_solid, is_valid=valid, free_edges=free, volume=volume)
