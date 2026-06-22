"""Surface-fidelity metric: Scaled Chamfer Distance (SCD) between a reconstructed B-rep and the
input mesh.

Ported (Apache-2.0) from StepForge's `reward/step_to_pointcloud.py` (adaptive-deflection
`BRepMesh_IncrementalMesh` tessellation → area-weighted barycentric surface sampling) and
`reward/scd_reward.py` (bidirectional Chamfer via `scipy.spatial.cKDTree`, normalized by the
input's RMS radius). See `docs/adr/0001-scd-fidelity-metric.md`.

Two deviations from StepForge, both deliberate:
  • **No alignment.** StepForge runs FPFH+RANSAC+ICP (`reward/alignment.py`, the only open3d user)
    because it compares an LLM-generated STEP against ground truth in an arbitrary pose. Our
    reconstructed solid is built *from* the input mesh — same coordinate frame — so we skip it and
    add no open3d dependency.
  • **Deterministic by construction (NFR-2).** Sampling is seeded; the same geometry always yields
    the same `surface_deviation`.

`surface_deviation` = CD(P_recon, P_mesh) / scale², where scale = RMS distance of the mesh's sampled
points from their centroid — a dimensionless, pose/scale-robust score that complements the existing
volume gate (a single scalar that two different shapes can share).
"""

from __future__ import annotations

import numpy as np
import trimesh
from OCC.Core.Bnd import Bnd_Box
from OCC.Core.BRep import BRep_Tool
from OCC.Core.BRepBndLib import brepbndlib
from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
from OCC.Core.TopLoc import TopLoc_Location
from OCC.Core.TopoDS import TopoDS_Shape, topods
from scipy.spatial import cKDTree

# Default sample size — matches StepForge's reward default; dense enough that two samples of the
# same surface give a near-zero Chamfer, cheap enough for a per-reconstruction gate.
DEFAULT_N_POINTS = 2000

# Advisory acceptance threshold for `surface_deviation` (SCD). StepForge's δ_low: a reconstruction
# whose surface tracks the input mesh scores below this; a genuine shape mismatch scores far above
# (sphere-vs-box ≈ 0.13). Reported as `fidelity_tol`; used as an optional accuracy-ladder gate (M1.5).
FIDELITY_TOL = 0.01


def _tessellate_shape(shape: TopoDS_Shape) -> tuple[np.ndarray, np.ndarray]:
    """Triangulate `shape` and return (world-space triangles (T,3,3), per-triangle areas (T,)).

    Deflection is adaptive (bbox-diagonal-scaled), matching StepForge: a fixed deflection collapses
    small parts to single triangles and over-tessellates large ones. Face triangulations are in
    face-local coordinates — the `TopLoc_Location` transform must be applied."""
    bbox = Bnd_Box()
    brepbndlib.Add(shape, bbox)
    if bbox.IsVoid():
        return np.empty((0, 3, 3)), np.empty((0,))
    xmin, ymin, zmin, xmax, ymax, zmax = bbox.Get()
    diag = float(np.sqrt((xmax - xmin) ** 2 + (ymax - ymin) ** 2 + (zmax - zmin) ** 2))
    deflection = max(diag * 1e-3, 1e-6)
    BRepMesh_IncrementalMesh(shape, deflection, False, 0.5, True).Perform()

    all_tris: list[np.ndarray] = []
    all_areas: list[np.ndarray] = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = topods.Face(exp.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation(face, loc)
        if tri is not None:
            trsf = loc.Transformation()
            identity = trsf.Form() == 0  # gp_Identity
            n_nodes = tri.NbNodes()
            nodes = np.empty((n_nodes, 3), dtype=np.float64)
            for i in range(1, n_nodes + 1):
                p = tri.Node(i)
                if not identity:
                    p = p.Transformed(trsf)
                nodes[i - 1] = (p.X(), p.Y(), p.Z())
            n_t = tri.NbTriangles()
            idx = np.empty((n_t, 3), dtype=np.int64)
            for i in range(1, n_t + 1):
                a, b, c = tri.Triangle(i).Get()
                idx[i - 1] = (a - 1, b - 1, c - 1)
            face_tris = nodes[idx]  # (n_t, 3, 3)
            e1 = face_tris[:, 1] - face_tris[:, 0]
            e2 = face_tris[:, 2] - face_tris[:, 0]
            areas = 0.5 * np.linalg.norm(np.cross(e1, e2), axis=1)
            keep = areas > 0
            if keep.any():
                all_tris.append(face_tris[keep])
                all_areas.append(areas[keep])
        exp.Next()

    if not all_tris:
        return np.empty((0, 3, 3)), np.empty((0,))
    return np.concatenate(all_tris, axis=0), np.concatenate(all_areas, axis=0)


def _sample_triangles(tris: np.ndarray, areas: np.ndarray, n_points: int, seed: int) -> np.ndarray:
    """Area-weighted barycentric surface sampling (StepForge W3). Seeded → deterministic.

    Choose triangles with probability ∝ area, then a uniform point inside each via the reflected
    barycentric (u, v) trick. Non-finite samples (from degenerate faces) are dropped."""
    if len(tris) == 0:
        return np.empty((0, 3))
    p = areas / areas.sum()
    rng = np.random.default_rng(int(seed) & 0xFFFFFFFF)
    choices = rng.choice(len(tris), size=n_points, p=p)
    u = rng.random(n_points)
    v = rng.random(n_points)
    flip = (u + v) > 1
    u[flip] = 1 - u[flip]
    v[flip] = 1 - v[flip]
    t = tris[choices]
    pts = t[:, 0] + u[:, None] * (t[:, 1] - t[:, 0]) + v[:, None] * (t[:, 2] - t[:, 0])
    finite = np.isfinite(pts).all(axis=1)
    return pts[finite]


def sample_shape_surface(
    shape: TopoDS_Shape, n_points: int = DEFAULT_N_POINTS, seed: int = 0
) -> np.ndarray:
    """Sample `n_points` points uniformly over the surface area of an OCC shape. Deterministic."""
    tris, areas = _tessellate_shape(shape)
    return _sample_triangles(tris, areas, n_points, seed)


def sample_mesh_surface(
    mesh: trimesh.Trimesh, n_points: int = DEFAULT_N_POINTS, seed: int = 0
) -> np.ndarray:
    """Sample `n_points` points uniformly over a triangle mesh's surface area. Deterministic.

    Uses the same area-weighted barycentric sampler as `sample_shape_surface` so the two clouds in
    `surface_fidelity` are produced identically (only the geometry differs)."""
    tris = np.asarray(mesh.triangles, dtype=np.float64)
    areas = np.asarray(mesh.area_faces, dtype=np.float64)
    return _sample_triangles(tris, areas, n_points, seed)


def chamfer_distance(p: np.ndarray, q: np.ndarray, *, bidirectional: bool = True) -> float:
    """Bidirectional Chamfer (StepForge Eq. 1): mean squared nearest-neighbour distance each way.

    CD(P,Q) = mean_{p∈P} min_{q∈Q} ||p-q||² + mean_{q∈Q} min_{p∈P} ||p-q||²."""
    if len(p) == 0 or len(q) == 0:
        return float("inf")
    d_pq = cKDTree(q).query(p)[0]
    if not bidirectional:
        return float(np.mean(d_pq ** 2))
    d_qp = cKDTree(p).query(q)[0]
    return float(np.mean(d_pq ** 2) + np.mean(d_qp ** 2))


def scaled_chamfer(pred: np.ndarray, gt: np.ndarray, *, bidirectional: bool = True) -> float:
    """Scaled Chamfer Distance (StepForge Eq. 2), alignment dropped (same frame).

    SCD = CD(pred, gt) / scale², scale = RMS distance of `gt` from its centroid. Dimensionless,
    translation/rotation/scale-robust. Returns inf if `gt` is degenerate (zero scale)."""
    pred = np.asarray(pred, dtype=np.float64)
    gt = np.asarray(gt, dtype=np.float64)
    if len(pred) == 0 or len(gt) == 0:
        return float("inf")
    gt_centered = gt - gt.mean(axis=0)
    scale = float(np.sqrt(np.mean(np.sum(gt_centered ** 2, axis=1))))
    if scale < 1e-8:
        return float("inf")
    pred_centered = pred - gt.mean(axis=0)  # same shift preserves the relative pose
    return chamfer_distance(pred_centered, gt_centered, bidirectional=bidirectional) / (scale ** 2)


def surface_fidelity(
    shape: TopoDS_Shape,
    mesh: trimesh.Trimesh,
    n_points: int = DEFAULT_N_POINTS,
    seed: int | None = None,
) -> float:
    """`surface_deviation` = SCD between the reconstructed B-rep `shape` and the input `mesh`.

    Lower is better; ~0 means the reconstructed surface tracks the mesh. Deterministic: if `seed`
    is None it is derived from the mesh geometry, so the same input always scores the same. The two
    clouds use distinct seeds so they are independent draws of their respective surfaces."""
    if seed is None:
        seed = _seed_from_mesh(mesh)
    pred = sample_shape_surface(shape, n_points=n_points, seed=seed)
    gt = sample_mesh_surface(mesh, n_points=n_points, seed=(int(seed) ^ 0x9E3779B9) & 0xFFFFFFFF)
    return scaled_chamfer(pred, gt)


def _seed_from_mesh(mesh: trimesh.Trimesh) -> int:
    """A stable 32-bit seed from the mesh geometry (NFR-2: same mesh → same sample → same score).

    Hashes the rounded vertex/face buffers with SHA-256 (StepForge's approach) — deterministic and
    process-stable, unlike Python's per-process-salted `hash()`."""
    import hashlib

    v = np.ascontiguousarray(np.round(np.asarray(mesh.vertices, dtype=np.float64), 9))
    f = np.ascontiguousarray(np.asarray(mesh.faces, dtype=np.int64))
    digest = hashlib.sha256(v.tobytes() + f.tobytes()).digest()
    return int.from_bytes(digest[:4], "big")
