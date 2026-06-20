"""CSG / boolean reconstruction for non-coaxial mixed parts (SPEC-7 R6.4b-iii/iv).

Following the InverseCSG paradigm (MIT, SIGGRAPH Asia 2018): reconstruct a part as a boolean
combination of primitive solids rather than by stitching independently-fitted faces. OCCT's
boolean engine (`BRepAlgoAPI_Cut`/`Fuse`) computes the shared-edge topology robustly —
sidestepping the fragile manual surface–surface-intersection tail.

Scope: an axis-aligned box base with cylindrical features — through-HOLES (Cut) and protruding
BOSSES (Fuse). The base box is derived from the dominant (largest-area) axis-aligned planar
face per ±direction, so a boss's smaller top face doesn't inflate the base. Each cylindrical
region is a hole if its wall normals point INWARD (toward its axis) and a boss if they point
OUTWARD. Bosses are fused first, holes cut after. Self-validated by volume vs the watertight
mesh; rejected (→ caller falls back) if the result doesn't match. Deterministic.

Out of scope (→ faceted fallback): non-axis-aligned bases, non-cylindrical features, nested /
repeated CSG trees (full program-synthesis InverseCSG).
"""

from __future__ import annotations

from typing import Optional

import networkx as nx
import numpy as np
import trimesh
from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepGProp import brepgprop
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCC.Core.GProp import GProp_GProps
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer

from .curved_faces import SolidResult
from .primitives import CylinderFit, fit_cylinder


def _axis_aligned_mask(face_normals: np.ndarray, tol: float = 0.99) -> np.ndarray:
    fn = face_normals / np.linalg.norm(face_normals, axis=1, keepdims=True)
    return np.max(np.abs(fn), axis=1) > tol


def _base_box_from_planes(mesh: trimesh.Trimesh, aligned: np.ndarray) -> Optional[tuple[np.ndarray, np.ndarray]]:
    """Box (lo, hi) from the dominant axis-aligned plane per ±direction — the largest-area
    face offset, so a boss's small top doesn't extend the base. None if a face is missing."""
    fn = np.asarray(mesh.face_normals, dtype=float)
    centroids = np.asarray(mesh.triangles_center, dtype=float)
    areas = np.asarray(mesh.area_faces, dtype=float)
    lo = np.zeros(3)
    hi = np.zeros(3)
    for ax in range(3):
        for sign in (1.0, -1.0):
            sel = aligned & (np.sign(fn[:, ax]) == sign) & (np.abs(fn[:, ax]) > 0.99)
            if not sel.any():
                return None  # not a closed box (missing a face for this direction)
            offsets = np.round(centroids[sel, ax], 5)
            face_area = areas[sel]
            totals: dict[float, float] = {}
            for o, a in zip(offsets, face_area):
                totals[float(o)] = totals.get(float(o), 0.0) + float(a)
            dominant = max(totals, key=lambda k: totals[k])
            if sign > 0:
                hi[ax] = dominant
            else:
                lo[ax] = dominant
    if np.any(hi <= lo):
        return None
    return lo, hi


def _curved_components(mesh: trimesh.Trimesh, curved: np.ndarray) -> list[np.ndarray]:
    g = nx.Graph()
    g.add_nodes_from(int(i) for i in np.nonzero(curved)[0])
    for a, b in mesh.face_adjacency:
        if curved[a] and curved[b]:
            g.add_edge(int(a), int(b))
    return [np.array(sorted(c), dtype=np.int64) for c in nx.connected_components(g)]


def _faces(solid) -> int:
    n = 0
    exp = TopExp_Explorer(solid, TopAbs_FACE)
    while exp.More():
        n += 1
        exp.Next()
    return n


def _cylinder_tool(cyl: CylinderFit, start_proj: float, end_proj: float):
    """A cylinder solid along the fit axis spanning axial coords [start_proj, end_proj]
    (absolute projections onto the axis), radius = fit radius."""
    center_proj = float(cyl.center @ cyl.axis)
    start = cyl.center + (start_proj - center_proj) * cyl.axis
    height = end_proj - start_proj
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*start), gp_Dir(*cyl.axis)), cyl.radius, height).Shape()


def reconstruct_csg(vertices: np.ndarray, faces: np.ndarray, vol_tol: float = 0.03) -> Optional[SolidResult]:
    """Reconstruct an axis-aligned box with cylindrical holes/bosses as box (∪ bosses) (− holes)
    via OCCT booleans. Returns a watertight, volume-validated solid, or None if out of scope."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    if not mesh.is_watertight:
        return None
    mesh_volume = abs(float(mesh.volume))
    if mesh_volume <= 0:
        return None

    fn = np.asarray(mesh.face_normals, dtype=float)
    aligned = _axis_aligned_mask(fn)
    curved = ~aligned
    if curved.sum() < 4 or not aligned.any():
        return None

    box = _base_box_from_planes(mesh, aligned)
    if box is None:
        return None
    lo, hi = box
    diag = float(np.linalg.norm(hi - lo))
    base = BRepPrimAPI_MakeBox(gp_Pnt(*lo), float(hi[0] - lo[0]), float(hi[1] - lo[1]), float(hi[2] - lo[2])).Shape()
    # box corners (for projecting the base extent onto an arbitrary cylinder axis)
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])

    holes: list[CylinderFit] = []
    bosses: list[CylinderFit] = []
    for comp in _curved_components(mesh, curved):
        if len(comp) < 4:
            continue
        cverts = mesh.vertices[np.unique(mesh.faces[comp])]
        cfn = fn[comp]
        try:
            cyl = fit_cylinder(cverts, cfn)
        except Exception:  # noqa: BLE001
            continue
        if cyl.radius <= 0 or cyl.rms / cyl.radius > 0.05:
            continue  # not a clean cylinder
        centroids = mesh.triangles_center[comp]
        rel = centroids - cyl.center
        radial = rel - np.outer(rel @ cyl.axis, cyl.axis)
        rnorm = np.linalg.norm(radial, axis=1, keepdims=True)
        radial = np.divide(radial, rnorm, out=np.zeros_like(radial), where=rnorm > 1e-9)
        outwardness = float(np.mean(np.einsum("ij,ij->i", cfn, radial)))
        (bosses if outwardness > 0 else holes).append(cyl)

    if not holes and not bosses:
        return None

    solid = base
    # Fuse bosses first (additive), then cut holes (subtractive).
    for cyl in bosses:
        cp = corners @ cyl.axis
        b_lo, b_hi = float(cp.min()), float(cp.max())
        center_proj = float(cyl.center @ cyl.axis)
        wall_lo, wall_hi = center_proj + cyl.vmin, center_proj + cyl.vmax
        # span from inside the box to the protruding tip (whichever side sticks out)
        if wall_hi > b_hi:
            start_proj, end_proj = b_lo, wall_hi
        else:
            start_proj, end_proj = wall_lo, b_hi
        tool = _cylinder_tool(cyl, start_proj, end_proj)
        op = BRepAlgoAPI_Fuse(solid, tool)
        if not op.IsDone() or not BRepCheck_Analyzer(op.Shape()).IsValid():
            return None
        solid = op.Shape()
    for cyl in holes:
        cp = corners @ cyl.axis
        tool = _cylinder_tool(cyl, float(cp.min()) - diag, float(cp.max()) + diag)
        op = BRepAlgoAPI_Cut(solid, tool)
        if not op.IsDone() or not BRepCheck_Analyzer(op.Shape()).IsValid():
            return None
        solid = op.Shape()

    props = GProp_GProps()
    brepgprop.VolumeProperties(solid, props)
    volume = float(props.Mass())
    valid = BRepCheck_Analyzer(solid).IsValid()
    if not valid or volume <= 0 or abs(volume - mesh_volume) / mesh_volume > vol_tol:
        return None
    return SolidResult(solid, True, True, 0, volume, _faces(solid), primitive="csg")
