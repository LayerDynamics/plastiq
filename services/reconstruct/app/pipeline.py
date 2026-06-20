"""The reconstruction pipeline: mesh bytes → B-rep shape → STEP text + a report.

R6.1 wires the faceted path end to end (a complete, working mesh→STEP). Later milestones
slot a primitive-fitting stage (R6.3) and analytic-face replacement (R6.4) ahead of the
faceted fallback, upgrading the `method` reported here from "faceted" to "fitted".
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .faceted import faceted_shape
from .meshio import load_mesh
from .occ_step import shape_to_step


@dataclass
class ReconstructionReport:
    triangles_in: int
    faces_built: int
    is_solid: bool
    is_valid: bool
    method: str


@dataclass
class ReconstructionResult:
    step: str
    report: ReconstructionReport

    def to_dict(self) -> dict:
        return {"step": self.step, "report": asdict(self.report)}


def reconstruct(data: bytes, file_type: str = "glb") -> ReconstructionResult:
    """Reconstruct a mesh into a B-rep STEP. The single entry point the service calls."""
    vertices, faces = load_mesh(data, file_type)
    result = faceted_shape(vertices, faces)
    step = shape_to_step(result.shape)
    report = ReconstructionReport(
        triangles_in=result.triangles_in,
        faces_built=result.faces_built,
        is_solid=result.is_solid,
        is_valid=result.is_valid,
        method="faceted",
    )
    return ReconstructionResult(step=step, report=report)
