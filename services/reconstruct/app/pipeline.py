"""The reconstruction pipeline: mesh bytes → B-rep shape → STEP text + a report.

Default method is "auto": clean the mesh, then if the whole mesh is a single analytic
primitive (sphere/cylinder/cone — R6.4) emit that watertight analytic solid; otherwise fall
back to "fitted" (R6.3/R6.4 — planar facets → trimmed faces, faceted fallback per region).
"faceted" (R6.1) is the per-triangle baseline. Mixed multi-primitive parts with shared-edge
topology are R6.4b+. Nothing is ever dropped (faceted fallback).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional

from .cleanup import clean_mesh
from .detect import try_single_primitive
from .faceted import faceted_shape
from .fitted import fitted_shape
from .meshio import load_mesh
from .occ_step import shape_to_step
from .revolution import reconstruct_revolution


@dataclass
class ReconstructionReport:
    triangles_in: int
    triangles_used: int
    faces_built: int
    planar_faces: int
    is_solid: bool
    is_valid: bool
    method: str
    primitive: Optional[str] = None  # "cylinder" | "sphere" | "cone" when method=="auto" hit one


@dataclass
class ReconstructionResult:
    step: str
    report: ReconstructionReport

    def to_dict(self) -> dict:
        return {"step": self.step, "report": asdict(self.report)}


def reconstruct(
    data: bytes,
    file_type: str = "glb",
    *,
    clean: bool = True,
    method: str = "auto",
) -> ReconstructionResult:
    """Reconstruct a mesh into a B-rep STEP. The single entry point the service calls.
    `method`: "auto" (single-primitive → else fitted; default), "fitted" (planar facets →
    trimmed faces), or "faceted" (per-triangle baseline)."""
    vertices, faces = load_mesh(data, file_type)
    raw_triangles = len(faces)
    if clean:
        vertices, faces = clean_mesh(vertices, faces)
    used = len(faces)

    if method == "auto":
        # 1) whole mesh is one analytic primitive (cleanest result for cylinder/sphere/cone)
        prim = try_single_primitive(vertices, faces)
        if prim is not None:
            report = ReconstructionReport(
                triangles_in=raw_triangles,
                triangles_used=used,
                faces_built=prim.n_faces,
                planar_faces=0,
                is_solid=prim.is_solid,
                is_valid=prim.is_valid,
                method=prim.primitive or "primitive",
                primitive=prim.primitive,
            )
            return ReconstructionResult(step=shape_to_step(prim.shape), report=report)
        # 2) a multi-segment solid of revolution (stepped shaft, chamfered/capped cylinder)
        rev = reconstruct_revolution(vertices, faces)
        if rev is not None:
            report = ReconstructionReport(
                triangles_in=raw_triangles,
                triangles_used=used,
                faces_built=rev.n_faces,
                planar_faces=0,
                is_solid=rev.is_solid,
                is_valid=rev.is_valid,
                method="revolution",
                primitive="revolution",
            )
            return ReconstructionResult(step=shape_to_step(rev.shape), report=report)
        method = "fitted"  # not a primitive / revolution → fall through

    if method == "faceted":
        result = faceted_shape(vertices, faces)
        report = ReconstructionReport(
            triangles_in=raw_triangles,
            triangles_used=used,
            faces_built=result.faces_built,
            planar_faces=0,
            is_solid=result.is_solid,
            is_valid=result.is_valid,
            method="faceted",
        )
        shape = result.shape
    elif method == "fitted":
        fitted = fitted_shape(vertices, faces)
        report = ReconstructionReport(
            triangles_in=raw_triangles,
            triangles_used=used,
            faces_built=fitted.planar_faces + fitted.triangle_faces,
            planar_faces=fitted.planar_faces,
            is_solid=fitted.is_solid,
            is_valid=fitted.is_valid,
            method="fitted",
        )
        shape = fitted.shape
    else:
        raise ValueError(f"unknown reconstruction method: {method!r}")

    return ReconstructionResult(step=shape_to_step(shape), report=report)
