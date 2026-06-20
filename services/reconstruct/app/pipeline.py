"""The reconstruction pipeline: mesh bytes → B-rep shape → STEP text + a report.

Default method is "fitted" (R6.3/R6.4): clean the mesh, group coplanar triangles into
facets, and collapse each planar facet into a single trimmed B-rep face (faceted fallback
for holed facets + leftover triangles). "faceted" (R6.1) is kept selectable as the
per-triangle baseline. Curved-surface fitting (cylinders/spheres) is a later milestone.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .cleanup import clean_mesh
from .faceted import faceted_shape
from .fitted import fitted_shape
from .meshio import load_mesh
from .occ_step import shape_to_step


@dataclass
class ReconstructionReport:
    triangles_in: int
    triangles_used: int
    faces_built: int
    planar_faces: int
    is_solid: bool
    is_valid: bool
    method: str


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
    method: str = "fitted",
) -> ReconstructionResult:
    """Reconstruct a mesh into a B-rep STEP. The single entry point the service calls.
    `method`: "fitted" (planar facets → trimmed faces; default) or "faceted" (per-triangle)."""
    vertices, faces = load_mesh(data, file_type)
    raw_triangles = len(faces)
    if clean:
        vertices, faces = clean_mesh(vertices, faces)

    if method == "faceted":
        result = faceted_shape(vertices, faces)
        report = ReconstructionReport(
            triangles_in=raw_triangles,
            triangles_used=len(faces),
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
            triangles_used=len(faces),
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
