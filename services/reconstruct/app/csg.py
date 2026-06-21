"""CSG / boolean reconstruction for non-coaxial mixed parts (SPEC-7 R6.4b-iii/iv).

Following the InverseCSG paradigm (MIT, SIGGRAPH Asia 2018): reconstruct a part as a boolean
combination of primitive solids rather than by stitching independently-fitted faces. OCCT's
boolean engine (`BRepAlgoAPI_Cut`/`Fuse`) computes the shared-edge topology robustly —
sidestepping the fragile manual surface–surface-intersection tail.

Scope: a box base (axis-aligned OR arbitrarily rotated) with one or more cylindrical
features — through-HOLES (Cut) and protruding BOSSES (Fuse). The base box is derived from the
dominant (largest-area) planar face per ±direction of the box frame, so a boss's smaller top
face doesn't inflate the base. Each cylindrical region is a hole if its wall normals point
INWARD (toward its axis) and a boss if they point OUTWARD. Bosses are fused first, holes cut
after. Self-validated by volume vs the watertight mesh; rejected (→ caller falls back) if the
result doesn't match. Deterministic (area-sorted normal clustering + closed-form fits, no
RANSAC).

The box frame is found two ways, tried in order: (1) the WORLD axes when the part is
axis-aligned (the common, simplest case); (2) an ORIENTED frame derived from the part's own
dominant planar-face normals, so a rotated box reconstructs too (R6.4b general-CSG increment).

Out of scope (→ faceted fallback): non-cylindrical features, non-box bases, nested / repeated
CSG trees (full program-synthesis InverseCSG)."""

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


def _oriented_frame(face_normals: np.ndarray, areas: np.ndarray, ang_cos: float = 0.985) -> Optional[np.ndarray]:
    """Derive the box's orthonormal frame (rows e1,e2,e3) from its dominant planar-face
    normals, so a ROTATED box reconstructs. Deterministic: cluster normals by axis (±merged),
    sorted by total area; the largest cluster is e1, the largest cluster orthogonal to it is
    e2, e3 = e1×e2. Requires a planar cluster supporting the e3 axis too (a real box has all
    three). Returns None when the part isn't box-framed (e.g. a cylinder's normal smear)."""
    order = np.argsort(-areas)  # largest face first (stable, deterministic)
    clusters: list[list] = []  # [unit_dir, total_area]
    for i in order:
        n = face_normals[i]
        nn = n / (np.linalg.norm(n) + 1e-12)
        for c in clusters:
            if abs(float(nn @ c[0])) >= ang_cos:  # same axis (antipodal merged)
                c[1] += float(areas[i])
                break
        else:
            clusters.append([nn, float(areas[i])])
    clusters.sort(key=lambda c: -c[1])
    if len(clusters) < 3:
        return None
    e1 = clusters[0][0]
    e2 = None
    for c in clusters[1:]:
        if abs(float(c[0] @ e1)) < 0.15:  # orthogonal candidate
            v = c[0] - (c[0] @ e1) * e1
            e2 = v / np.linalg.norm(v)
            break
    if e2 is None:
        return None
    e3 = np.cross(e1, e2)
    e3 /= np.linalg.norm(e3)
    if not any(abs(float(c[0] @ e3)) >= ang_cos for c in clusters):
        return None  # no planar face supports the third axis → not a closed box
    return np.vstack([e1, e2, e3])


def _planar_mask(face_normals: np.ndarray, frame: np.ndarray, ang_cos: float = 0.985) -> np.ndarray:
    """Faces whose normal aligns (±) with any frame axis — the box's flat faces."""
    return np.max(np.abs(face_normals @ frame.T), axis=1) >= ang_cos


def _base_box_oriented(
    mesh: trimesh.Trimesh, frame: np.ndarray, planar: np.ndarray
) -> Optional[tuple[np.ndarray, np.ndarray]]:
    """Box extents (lo, hi) in FRAME coordinates from the dominant planar face per ±axis (so a
    boss's small top doesn't inflate the base). None if a face is missing for some direction."""
    fn = np.asarray(mesh.face_normals, dtype=float)
    centroids = np.asarray(mesh.triangles_center, dtype=float)
    areas = np.asarray(mesh.area_faces, dtype=float)
    lo = np.zeros(3)
    hi = np.zeros(3)
    for ax in range(3):
        for sign in (1.0, -1.0):
            d = sign * frame[ax]
            sel = planar & ((fn @ d) > 0.985)
            if not sel.any():
                return None
            offsets = np.round(centroids[sel] @ frame[ax], 5)
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


def _oriented_corners(lo: np.ndarray, hi: np.ndarray, frame: np.ndarray) -> np.ndarray:
    """The 8 box corners in WORLD coordinates from frame-space extents."""
    combos = [(a, b, c) for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])]
    return np.array([a * frame[0] + b * frame[1] + c * frame[2] for a, b, c in combos])


def _apply_features(
    mesh: trimesh.Trimesh,
    base,
    corners: np.ndarray,
    curved: np.ndarray,
    fn: np.ndarray,
    mesh_volume: float,
    vol_tol: float,
) -> Optional[SolidResult]:
    """Fit each connected curved region to a cylinder, classify hole vs boss by wall-normal
    direction, fuse bosses then cut holes via OCCT booleans, and volume-validate the result.
    Shared by the axis-aligned and oriented base paths. None if out of scope / mismatched."""
    diag = float(np.linalg.norm(corners.max(axis=0) - corners.min(axis=0)))
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
    for cyl in bosses:  # additive first
        cp = corners @ cyl.axis
        b_lo, b_hi = float(cp.min()), float(cp.max())
        center_proj = float(cyl.center @ cyl.axis)
        wall_lo, wall_hi = center_proj + cyl.vmin, center_proj + cyl.vmax
        if wall_hi > b_hi:
            start_proj, end_proj = b_lo, wall_hi
        else:
            start_proj, end_proj = wall_lo, b_hi
        op = BRepAlgoAPI_Fuse(solid, _cylinder_tool(cyl, start_proj, end_proj))
        if not op.IsDone() or not BRepCheck_Analyzer(op.Shape()).IsValid():
            return None
        solid = op.Shape()
    for cyl in holes:  # subtractive after
        cp = corners @ cyl.axis
        tool = _cylinder_tool(cyl, float(cp.min()) - diag, float(cp.max()) + diag)
        op = BRepAlgoAPI_Cut(solid, tool)
        if not op.IsDone() or not BRepCheck_Analyzer(op.Shape()).IsValid():
            return None
        solid = op.Shape()

    props = GProp_GProps()
    brepgprop.VolumeProperties(solid, props)
    volume = float(props.Mass())
    if not BRepCheck_Analyzer(solid).IsValid() or volume <= 0 or abs(volume - mesh_volume) / mesh_volume > vol_tol:
        return None
    return SolidResult(solid, True, True, 0, volume, _faces(solid), primitive="csg")


def reconstruct_csg(vertices: np.ndarray, faces: np.ndarray, vol_tol: float = 0.03) -> Optional[SolidResult]:
    """Reconstruct a box (axis-aligned OR rotated) with cylindrical holes/bosses as
    box (∪ bosses) (− holes) via OCCT booleans. Returns a watertight, volume-validated solid,
    or None if out of scope. Tries the world-aligned base first, then an oriented frame."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices, dtype=float),
                           faces=np.asarray(faces, dtype=np.int64), process=False)
    if not mesh.is_watertight:
        return None
    mesh_volume = abs(float(mesh.volume))
    if mesh_volume <= 0:
        return None

    fn = np.asarray(mesh.face_normals, dtype=float)
    areas = np.asarray(mesh.area_faces, dtype=float)

    # 1) World-aligned base (the common, simplest case — proven path).
    aligned = _axis_aligned_mask(fn)
    if aligned.any() and (~aligned).sum() >= 4:
        box = _base_box_from_planes(mesh, aligned)
        if box is not None:
            lo, hi = box
            base = BRepPrimAPI_MakeBox(
                gp_Pnt(*lo), float(hi[0] - lo[0]), float(hi[1] - lo[1]), float(hi[2] - lo[2])
            ).Shape()
            corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
            res = _apply_features(mesh, base, corners, ~aligned, fn, mesh_volume, vol_tol)
            if res is not None:
                return res

    # 2) Oriented (rotated) box base — frame from the part's own dominant planar normals.
    frame = _oriented_frame(fn, areas)
    if frame is None:
        return None
    planar = _planar_mask(fn, frame)
    curved = ~planar
    if curved.sum() < 4 or not planar.any():
        return None
    box = _base_box_oriented(mesh, frame, planar)
    if box is None:
        return None
    lo, hi = box
    e1, e2, e3 = frame[0], frame[1], frame[2]
    corner = lo[0] * e1 + lo[1] * e2 + lo[2] * e3
    base = BRepPrimAPI_MakeBox(
        gp_Ax2(gp_Pnt(*corner), gp_Dir(*e3), gp_Dir(*e1)),
        float(hi[0] - lo[0]), float(hi[1] - lo[1]), float(hi[2] - lo[2]),
    ).Shape()
    corners = _oriented_corners(lo, hi, frame)
    return _apply_features(mesh, base, corners, curved, fn, mesh_volume, vol_tol)
