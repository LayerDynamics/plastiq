"""CSG / boolean reconstruction for non-coaxial mixed parts (SPEC-7 R6.4b-iii).

Following the InverseCSG paradigm (MIT, SIGGRAPH Asia 2018): reconstruct a part as a boolean
combination of primitive solids rather than by stitching independently-fitted faces. OCCT's
boolean engine (`BRepAlgoAPI_Cut`) computes the shared-edge topology robustly — sidestepping
the fragile manual surface–surface-intersection tail.

Bounded scope (this milestone): an axis-aligned box with one or more cylindrical THROUGH-HOLES
(drilled plates — a very common mechanical class). The base is the mesh AABB (exact for an
axis-aligned box whose only features are internal holes); each cylindrical region whose wall
normals point INWARD (toward its axis) is a hole and is Cut from the base. Additive bosses and
non-axis-aligned bases are out of this bounded scope (→ caller falls back to fitted/faceted).
Self-validated by volume: the result must match the watertight mesh's volume, else rejected.
Deterministic.
"""

from __future__ import annotations

from typing import Optional

import networkx as nx
import numpy as np
import trimesh
from OCC.Core.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCC.Core.BRepCheck import BRepCheck_Analyzer
from OCC.Core.BRepGProp import brepgprop
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCC.Core.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCC.Core.GProp import GProp_GProps
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer

from .curved_faces import SolidResult
from .primitives import fit_cylinder


def _axis_aligned_mask(face_normals: np.ndarray, tol: float = 0.99) -> np.ndarray:
    """True for faces whose normal is within `tol` of a coordinate axis (±X/±Y/±Z)."""
    fn = face_normals / np.linalg.norm(face_normals, axis=1, keepdims=True)
    return np.max(np.abs(fn), axis=1) > tol


def _curved_components(mesh: trimesh.Trimesh, curved: np.ndarray) -> list[np.ndarray]:
    """Connected components (by face adjacency) of the curved (non-axis-aligned) faces."""
    g = nx.Graph()
    curved_idx = np.nonzero(curved)[0]
    g.add_nodes_from(int(i) for i in curved_idx)
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


def reconstruct_csg(vertices: np.ndarray, faces: np.ndarray, vol_tol: float = 0.03) -> Optional[SolidResult]:
    """Reconstruct an axis-aligned box with cylindrical through-holes as (box − cylinders).
    Returns a watertight solid validated by volume, or None if the part isn't this shape."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    if not mesh.is_watertight:
        return None
    mesh_volume = abs(float(mesh.volume))
    if mesh_volume <= 0:
        return None

    fn = np.asarray(mesh.face_normals, dtype=float)
    aligned = _axis_aligned_mask(fn)
    if aligned.all():
        return None  # pure prism — the fitted (planar) path handles it
    curved = ~aligned
    if curved.sum() < 4:
        return None
    # The planar faces must be axis-aligned for an AABB base (else not in scope).
    if not aligned.any():
        return None

    lo, hi = mesh.bounds
    base = BRepPrimAPI_MakeBox(gp_Pnt(*lo), float(hi[0] - lo[0]), float(hi[1] - lo[1]), float(hi[2] - lo[2])).Shape()
    diag = float(np.linalg.norm(hi - lo))

    solid = base
    n_holes = 0
    for comp in _curved_components(mesh, curved):
        if len(comp) < 4:
            continue
        cverts = mesh.vertices[np.unique(mesh.faces[comp])]
        cfn = fn[comp]
        try:
            cyl = fit_cylinder(cverts, cfn)
        except Exception:  # noqa: BLE001
            continue
        if cyl.radius <= 0 or cyl.rms / cyl.radius > 0.03:
            continue  # not a clean cylinder

        # Hole vs boss: a hole's wall normals point INWARD (toward the axis).
        centroids = mesh.triangles_center[comp]
        rel = centroids - cyl.center
        radial = rel - np.outer(rel @ cyl.axis, cyl.axis)
        rnorm = np.linalg.norm(radial, axis=1, keepdims=True)
        radial = np.divide(radial, rnorm, out=np.zeros_like(radial), where=rnorm > 1e-9)
        if float(np.mean(np.einsum("ij,ij->i", cfn, radial))) >= 0:
            continue  # outward ⇒ boss (not in this bounded scope)

        # Cut a cylinder extended well beyond the box along the hole axis.
        start = cyl.center + cyl.axis * (cyl.vmin - diag)
        tool = BRepPrimAPI_MakeCylinder(
            gp_Ax2(gp_Pnt(*start), gp_Dir(*cyl.axis)), cyl.radius, cyl.height + 2 * diag
        ).Shape()
        cut = BRepAlgoAPI_Cut(solid, tool)
        if not cut.IsDone():
            continue
        result = cut.Shape()
        if not BRepCheck_Analyzer(result).IsValid():
            continue
        solid = result
        n_holes += 1

    if n_holes == 0:
        return None

    props = GProp_GProps()
    brepgprop.VolumeProperties(solid, props)
    volume = float(props.Mass())
    valid = BRepCheck_Analyzer(solid).IsValid()
    if not valid or volume <= 0 or abs(volume - mesh_volume) / mesh_volume > vol_tol:
        return None  # not faithfully a box-with-holes → reject
    return SolidResult(solid, True, True, 0, volume, _faces(solid), primitive="csg")
