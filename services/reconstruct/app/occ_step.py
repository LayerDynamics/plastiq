"""Write an OCCT shape to STEP text, in MILLIMETRES.

Matches the @plastiq/cad STEP I/O convention (packages/cad/src/io/index.ts):
STEPControl_AsIs, and coordinates scaled to MILLIMETRES so they agree with the
unit OCCT declares in the file.

Units (FablesFindings I1) — why the scale is here
------------------------------------------------
This module used to write RAW coordinates and rely on OCCT's default write unit,
explicitly so the STEP "round-tripped back through the kernel's importStep with
consistent units". That worked only because BOTH sides were wrong in the same
direction: the pipeline's shapes are in SI METRES, OCCT writes their raw numbers
and separately DECLARES the file millimetre, so a 20 mm feature was emitted as
`2.E-02` — i.e. "0.02 mm", 1000x too small. Any OTHER CAD system opening the file
got a part 1000x too small; only Plastiq's equally-wrong reader made it look fine.

The kernel now scales at its own boundary (metres -> mm on export, mm -> metres on
import), so a producer that still emitted raw SI numbers would be read 1000x too
SMALL. Scaling here keeps the round trip correct AND makes the emitted file
honest for every other consumer.
"""

from __future__ import annotations

import os
import tempfile

from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCC.Core.gp import gp_Pnt, gp_Trsf
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCC.Core.TopoDS import TopoDS_Shape

#: Pipeline shapes are SI metres; STEP declares millimetres.
M_TO_MM = 1000.0


def _to_millimetres(shape: TopoDS_Shape) -> TopoDS_Shape:
    """Scale an SI-metre shape into millimetres (a copy; the input is untouched)."""
    trsf = gp_Trsf()
    trsf.SetScale(gp_Pnt(0.0, 0.0, 0.0), M_TO_MM)
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


def shape_to_step(shape: TopoDS_Shape) -> str:
    """Serialize an OCCT shape to STEP (AP214) text. Raises on a non-RetDone status."""
    writer = STEPControl_Writer()
    if writer.Transfer(_to_millimetres(shape), STEPControl_AsIs) != IFSelect_RetDone:
        raise RuntimeError("STEP transfer failed (OCCT status not RetDone)")
    fd, path = tempfile.mkstemp(suffix=".step")
    os.close(fd)
    try:
        if writer.Write(path) != IFSelect_RetDone:
            raise RuntimeError("STEP write failed (OCCT status not RetDone)")
        with open(path, encoding="utf-8") as f:
            return f.read()
    finally:
        os.remove(path)
