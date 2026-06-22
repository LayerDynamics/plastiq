"""The reconstruction pipeline: mesh bytes → B-rep shape → STEP text + a report.

Default method is "auto": clean the mesh, then try the analytic routes in order and emit the
first watertight, volume-validated solid —
  1. single analytic primitive    sphere / cylinder / cone (R6.4, `detect.try_single_primitive`)
  2. solid of revolution          stepped/capped shaft (R6.4b, `revolution.reconstruct_revolution`)
  3. CSG                          box ± cylinders: holes/bosses (R6.4b, `csg.reconstruct_csg`)
  4. cut cylinder                 cylinder trimmed by oblique/axis-parallel planes
                                  (R6.9, `topology.reconstruct_cut_cylinder` — FR-6 GeomAPI_IntSS)
— otherwise fall back to "fitted" (R6.3/R6.4/R6.5 — planar facets → trimmed faces + freeform,
faceted fallback per region). "faceted" (R6.1) is the per-triangle baseline. Every analytic route
self-validates by volume against the cleaned mesh, so a near-miss falls through rather than
inventing geometry. Nothing is ever dropped (faceted fallback).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional

import numpy as np
import trimesh

from .cleanup import clean_mesh
from .csg import reconstruct_csg
from .curved_faces import classify_faces
from .detect import try_single_primitive
from .faceted import faceted_shape
from .fidelity import FIDELITY_TOL, surface_fidelity
from .fitted import fitted_shape
from .meshio import load_mesh
from .occ_step import shape_to_step
from .recognition import recognize
from .revolution import reconstruct_revolution
from .topology import reconstruct_cut_cylinder


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
    curved_faces: int = 0  # analytic non-planar faces (cylinder/sphere/cone/revolution) — FR-9
    freeform_faces: int = 0  # curved regions collapsed into freeform faces (R6.5), method="fitted"
    faceted_faces: int = 0  # per-triangle fallback faces that survived (FR-8 fallback) — FR-9
    # M1: Scaled Chamfer Distance of the built B-rep vs the cleaned input mesh — a pose/scale-robust
    # SURFACE fidelity score that complements the volume gate (docs/adr/0001). Lower = closer.
    surface_deviation: float = 0.0
    fidelity_tol: float = FIDELITY_TOL
    # M2c: number of tangent-connected regions recognised in the INPUT mesh (a box → 6, a cylinder
    # → 3, an organic blob → many) — a structural fingerprint for honest UX (docs/adr/0002).
    tangent_regions: int = 0


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

    # M1: the cleaned mesh is the ground truth every built shape is scored against (SCD).
    cleaned_mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=float),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )

    def deviation(shape) -> float:
        """Scaled Chamfer Distance of `shape` vs the cleaned input mesh (M1; docs/adr/0001)."""
        return surface_fidelity(shape, cleaned_mesh)

    # M2c: recognise the input mesh's tangent structure once; every result reports it.
    tangent_regions = recognize(vertices, faces)["tangent_regions"]

    def finish(shape, report: ReconstructionReport) -> ReconstructionResult:
        """Stamp the mesh-recognition count and emit the STEP result (single exit per branch)."""
        report.tangent_regions = tangent_regions
        return ReconstructionResult(step=shape_to_step(shape), report=report)

    if method == "auto":
        # 1) whole mesh is one analytic primitive (cleanest result for cylinder/sphere/cone)
        prim = try_single_primitive(vertices, faces)
        # M1.5: `surface_deviation` (SCD) is reported as an ADVISORY surface-fidelity number, not
        # an acceptance gate. Evidence (docs/adr/0001): a hard SCD ≤ tol gate over-rejected the
        # legitimately-coarse-but-correct oblique cut-cylinder (SCD 0.020 vs tol 0.01, yet volume
        # err only 1.5%, watertight). The existing volume + per-region-RMS + shape-coverage gates
        # already reject wrong primitives, so SCD ships report-only (and as the freeform gate later).
        prim_dev = deviation(prim.shape) if prim is not None else None
        if prim is not None:
            planar, curved, freeform = classify_faces(prim.shape)
            report = ReconstructionReport(
                triangles_in=raw_triangles,
                triangles_used=used,
                faces_built=prim.n_faces,
                planar_faces=planar,
                is_solid=prim.is_solid,
                is_valid=prim.is_valid,
                method=prim.primitive or "primitive",
                primitive=prim.primitive,
                curved_faces=curved,
                freeform_faces=freeform,
                surface_deviation=prim_dev,
            )
            return finish(prim.shape, report)
        # 2) a multi-segment solid of revolution (stepped shaft, chamfered/capped cylinder)
        rev = reconstruct_revolution(vertices, faces)
        rev_dev = deviation(rev.shape) if rev is not None else None
        if rev is not None:
            planar, curved, freeform = classify_faces(rev.shape)
            report = ReconstructionReport(
                triangles_in=raw_triangles,
                triangles_used=used,
                faces_built=rev.n_faces,
                planar_faces=planar,
                is_solid=rev.is_solid,
                is_valid=rev.is_valid,
                method="revolution",
                primitive="revolution",
                curved_faces=curved,
                freeform_faces=freeform,
                surface_deviation=rev_dev,
            )
            return finish(rev.shape, report)
        # 3) a box with cylindrical through-holes (CSG: box − cylinders)
        csg = reconstruct_csg(vertices, faces)
        csg_dev = deviation(csg.shape) if csg is not None else None
        if csg is not None:
            planar, curved, freeform = classify_faces(csg.shape)
            report = ReconstructionReport(
                triangles_in=raw_triangles,
                triangles_used=used,
                faces_built=csg.n_faces,
                planar_faces=planar,
                is_solid=csg.is_solid,
                is_valid=csg.is_valid,
                method="csg",
                primitive="csg",
                curved_faces=curved,
                freeform_faces=freeform,
                surface_deviation=csg_dev,
            )
            return finish(csg.shape, report)
        # 4) a cylinder trimmed by a non-perpendicular / axis-parallel plane (oblique cap, etc.)
        #    — FR-6 surface-intersection edge recovery (R6.9). Runs LAST among the analytic
        #    routes (after CSG, which is more mature) so it only claims meshes nothing else fit;
        #    self-validated by volume, faceted fallback otherwise. An oblique-cut cylinder has
        #    2 caps (not 3 orthogonal box planes), so CSG rejects it and this route fires.
        cutcyl = reconstruct_cut_cylinder(vertices, faces)
        cutcyl_dev = deviation(cutcyl.shape) if cutcyl is not None else None
        if cutcyl is not None:
            planar, curved, freeform = classify_faces(cutcyl.shape)
            report = ReconstructionReport(
                triangles_in=raw_triangles,
                triangles_used=used,
                faces_built=cutcyl.n_faces,
                planar_faces=planar,
                is_solid=cutcyl.is_solid,
                is_valid=cutcyl.is_valid,
                method="cut_cylinder",
                primitive="cut_cylinder",
                curved_faces=curved,
                freeform_faces=freeform,
                surface_deviation=cutcyl_dev,
            )
            return finish(cutcyl.shape, report)
        method = "fitted"  # not a primitive / revolution / CSG / cut-cylinder → fall through

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
            faceted_faces=result.faces_built,  # every face is a per-triangle fallback
            surface_deviation=deviation(result.shape),
        )
        shape = result.shape
    elif method == "fitted":
        fitted = fitted_shape(vertices, faces)
        report = ReconstructionReport(
            triangles_in=raw_triangles,
            triangles_used=used,
            faces_built=fitted.planar_faces + fitted.triangle_faces + fitted.freeform_faces,
            planar_faces=fitted.planar_faces,
            is_solid=fitted.is_solid,
            is_valid=fitted.is_valid,
            method="fitted",
            freeform_faces=fitted.freeform_faces,
            faceted_faces=fitted.triangle_faces,  # leftover regions kept per-triangle (FR-8)
            surface_deviation=deviation(fitted.shape),
        )
        shape = fitted.shape
    else:
        raise ValueError(f"unknown reconstruction method: {method!r}")

    return finish(shape, report)
