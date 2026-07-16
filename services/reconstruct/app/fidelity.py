"""Surface-fidelity metric: Scaled Chamfer Distance (SCD) between a reconstructed B-rep and the
input mesh.

Ported (Apache-2.0) from StepForge's `reward/step_to_pointcloud.py` (adaptive-deflection
`BRepMesh_IncrementalMesh` tessellation → area-weighted barycentric surface sampling) and
`reward/scd_reward.py` (bidirectional Chamfer, normalized by the input's RMS radius). See
`docs/adr/0001-scd-fidelity-metric.md`.

The metric MATH runs in **MLX** (`mlx.core`, Apple Silicon): area-weighted barycentric sampling
(categorical + uniform with explicit keys) and the bidirectional Chamfer (a brute-force pairwise
distance matrix → per-point min — MLX has no kd-tree, but a few-thousand-point matrix is trivial on
the GPU). OCC tessellation (pythonOCC) still produces the raw triangles; everything numerical after
that is MLX. Deterministic by seed.

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

import mlx.core as mx
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


def _sample_triangles(tris: np.ndarray, areas: np.ndarray, n_points: int, seed: int) -> mx.array:
    """Area-weighted barycentric surface sampling (StepForge W3) in MLX. Seeded (explicit key) →
    deterministic.

    Choose triangles with probability ∝ area (categorical), then a uniform point inside each via the
    reflected barycentric (u, v) trick. Returns an `(n, 3)` MLX array. Degenerate (zero-area) faces are
    already excluded upstream (`_tessellate_shape`), so every chosen triangle is finite."""
    if len(tris) == 0:
        return mx.zeros((0, 3))
    tris_mx = mx.array(np.asarray(tris, dtype=np.float32))  # (T, 3, 3)
    areas_mx = mx.array(np.asarray(areas, dtype=np.float32))
    probs = areas_mx / mx.sum(areas_mx)
    keys = mx.random.split(mx.random.key(int(seed) & 0xFFFFFFFF), 3)
    choices = mx.random.categorical(mx.log(probs), num_samples=n_points, key=keys[0])  # (n,)
    u = mx.random.uniform(shape=(n_points,), key=keys[1])
    v = mx.random.uniform(shape=(n_points,), key=keys[2])
    flip = (u + v) > 1
    u = mx.where(flip, 1 - u, u)
    v = mx.where(flip, 1 - v, v)
    t = mx.take(tris_mx, choices, axis=0)  # (n, 3, 3)
    return t[:, 0, :] + u[:, None] * (t[:, 1, :] - t[:, 0, :]) + v[:, None] * (t[:, 2, :] - t[:, 0, :])


def sample_shape_surface(shape: TopoDS_Shape, n_points: int = DEFAULT_N_POINTS, seed: int = 0) -> mx.array:
    """Sample `n_points` points uniformly over the surface area of an OCC shape (MLX). Deterministic."""
    tris, areas = _tessellate_shape(shape)
    return _sample_triangles(tris, areas, n_points, seed)


def sample_mesh_surface(mesh: trimesh.Trimesh, n_points: int = DEFAULT_N_POINTS, seed: int = 0) -> mx.array:
    """Sample `n_points` points uniformly over a triangle mesh's surface area (MLX). Deterministic.

    Uses the same area-weighted barycentric sampler as `sample_shape_surface` so the two clouds in
    `surface_fidelity` are produced identically (only the geometry differs)."""
    tris = np.asarray(mesh.triangles, dtype=np.float64)
    areas = np.asarray(mesh.area_faces, dtype=np.float64)
    return _sample_triangles(tris, areas, n_points, seed)


def chamfer_distance(p, q, *, bidirectional: bool = True, block: int = 2048) -> float:
    """Bidirectional Chamfer (StepForge Eq. 1) in MLX: mean squared nearest-neighbour distance each
    way, brute-force (no kd-tree).

    CD(P,Q) = mean_{p∈P} min_{q∈Q} ||p-q||² + mean_{q∈Q} min_{p∈P} ||p-q||²

    The pairwise distances are computed in row-blocks of `p` so peak memory is O(block·|Q|), NOT the
    full O(|P|·|Q|) matrix — a single block could otherwise OOM on large clouds (this is a public API).
    Per P-block: the P→Q direction takes each row's min; the Q→P direction keeps a running per-q min
    across blocks. The result is identical to the full-matrix computation."""
    p = p if isinstance(p, mx.array) else mx.array(np.asarray(p, dtype=np.float32))
    q = q if isinstance(q, mx.array) else mx.array(np.asarray(q, dtype=np.float32))
    n = p.shape[0]
    if n == 0 or q.shape[0] == 0:
        return float("inf")

    pq_min_sum = 0.0  # Σ over P of min_q ||p-q||²
    qp_min = None  # running min over P of ||p-q||², per q (for the reverse direction)
    for i in range(0, n, block):
        pb = p[i : i + block]
        d2 = mx.sum((pb[:, None, :] - q[None, :, :]) ** 2, axis=-1)  # (block, |Q|)
        pq_min_sum += float(mx.sum(mx.min(d2, axis=1)).item())
        if bidirectional:
            col_min = mx.min(d2, axis=0)  # (|Q|,) — best over this P-block
            qp_min = col_min if qp_min is None else mx.minimum(qp_min, col_min)
    d_pq = pq_min_sum / n
    if not bidirectional:
        return float(d_pq)
    return float(d_pq + float(mx.mean(qp_min).item()))


def scaled_chamfer(pred, gt, *, bidirectional: bool = True) -> float:
    """Scaled Chamfer Distance (StepForge Eq. 2) in MLX, alignment dropped (same frame).

    SCD = CD(pred, gt) / scale², scale = RMS distance of `gt` from its centroid. Dimensionless,
    translation/rotation/scale-robust. Returns inf if `gt` is degenerate (zero scale)."""
    pred = pred if isinstance(pred, mx.array) else mx.array(np.asarray(pred, dtype=np.float32))
    gt = gt if isinstance(gt, mx.array) else mx.array(np.asarray(gt, dtype=np.float32))
    if pred.shape[0] == 0 or gt.shape[0] == 0:
        return float("inf")
    centroid = mx.mean(gt, axis=0)
    gt_centered = gt - centroid
    scale = float(mx.sqrt(mx.mean(mx.sum(gt_centered ** 2, axis=1))).item())
    if scale < 1e-8:
        return float("inf")
    pred_centered = pred - centroid  # same shift preserves the relative pose
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
