"""Write an OCCT shape to STEP text.

Matches the @plastiq/cad STEP I/O convention (packages/cad/src/io/index.ts): raw
coordinates, OCCT's default write unit, STEPControl_AsIs — so the produced STEP round-trips
back through the kernel's importStep into a normal CadDocument with consistent units.
"""

from __future__ import annotations

import os
import tempfile

from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCC.Core.TopoDS import TopoDS_Shape


def shape_to_step(shape: TopoDS_Shape) -> str:
    """Serialize an OCCT shape to STEP (AP214) text. Raises on a non-RetDone status."""
    writer = STEPControl_Writer()
    if writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone:
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
