"""Mesh-side feature recognition (M2c) — the clean-room tangent-adjacency idea from the
@plastiq/cad selectors, computed over a triangle mesh.

Groups triangles into **tangent-connected regions** (faces joined across smooth, low-dihedral edges)
and flags which regions are **curved**. This is a structural fingerprint of the input mesh — a box
is 6 flat regions, a cylinder is one curved lateral + 2 flat caps, an organic blob is many — that
the reconstruction report surfaces for honest UX (NFR-4) and that a fitter could use to pre-group
regions before fitting. Implemented from the standard dihedral test, not from BRepNet's source
(docs/adr/0002).

The numerical math runs in **MLX** (`mlx.core`, Apple Silicon): the dihedral angles between adjacent
face normals and the per-region normal spread. The combinatorial parts stay where they belong —
trimesh extracts which triangles share an edge, and connected components is a Python union-find (MLX
is a tensor framework, not a graph library). Deterministic (fixed thresholds, fixed traversal), NFR-2.
"""

from __future__ import annotations

import mlx.core as mx
import numpy as np
import trimesh

# Two adjacent triangles whose normals differ by less than this are a smooth (tangent) join — same
# surface patch. Above it is a crease (a real B-rep edge between faces). 20° cleanly separates a
# cylinder's facet-to-facet (~7.5° at 48 sections) from a box's 90° corners.
SMOOTH_ANGLE_DEG = 20.0
# A region whose face normals spread beyond this from their mean is curved (not a single plane).
CURVED_SPREAD_DEG = 10.0


def _mesh(vertices: np.ndarray, faces: np.ndarray) -> trimesh.Trimesh:
    return trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=float),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )


def _connected_components(n: int, pairs: np.ndarray) -> np.ndarray:
    """Union-find connected components over `n` nodes joined by `pairs` (a graph algorithm; MLX has
    no equivalent). Roots are relabelled to 0..k−1 in first-seen order → deterministic."""
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            parent[ra] = rb

    labels = np.empty(n, dtype=np.int64)
    roots: dict[int, int] = {}
    for i in range(n):
        r = find(i)
        if r not in roots:
            roots[r] = len(roots)
        labels[i] = roots[r]
    return labels


def group_tangent_regions(
    vertices: np.ndarray, faces: np.ndarray, smooth_angle_deg: float = SMOOTH_ANGLE_DEG
) -> np.ndarray:
    """Label each triangle with its tangent-connected region id (connected components over smooth —
    low-dihedral — face adjacencies). The dihedral angle between adjacent face normals is computed in
    MLX; the adjacency + components are combinatorial. Deterministic."""
    mesh = _mesh(vertices, faces)
    n = len(mesh.faces)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    adjacency = mesh.face_adjacency  # (m, 2) pairs of triangles sharing an edge (trimesh, combinatorial)
    if len(adjacency) == 0:
        return _connected_components(n, np.empty((0, 2), dtype=np.int64))
    fn = mx.array(np.asarray(mesh.face_normals, dtype=np.float32))  # (n, 3) — MLX
    na = mx.take(fn, mx.array(np.asarray(adjacency[:, 0], dtype=np.int32)), axis=0)
    nb = mx.take(fn, mx.array(np.asarray(adjacency[:, 1], dtype=np.int32)), axis=0)
    angle_deg = mx.degrees(mx.arccos(mx.clip(mx.sum(na * nb, axis=1), -1.0, 1.0)))
    smooth = np.asarray(angle_deg < smooth_angle_deg)  # (m,) bool
    return _connected_components(n, adjacency[smooth])


def recognize(
    vertices: np.ndarray,
    faces: np.ndarray,
    smooth_angle_deg: float = SMOOTH_ANGLE_DEG,
    curved_spread_deg: float = CURVED_SPREAD_DEG,
) -> dict[str, int]:
    """Recognise the part's tangent structure: how many tangent-connected regions it has, and how
    many of those are curved (non-planar). The per-region normal spread is computed in MLX. Deterministic."""
    mesh = _mesh(vertices, faces)
    if len(mesh.faces) == 0:
        return {"tangent_regions": 0, "curved_regions": 0}
    labels = group_tangent_regions(vertices, faces, smooth_angle_deg)
    fn = mx.array(np.asarray(mesh.face_normals, dtype=np.float32))
    curved = 0
    unique_labels = sorted(set(labels.tolist()))
    for r in unique_labels:
        idx = np.where(labels == r)[0].astype(np.int32)
        region = mx.take(fn, mx.array(idx), axis=0)  # (k, 3)
        mean = mx.mean(region, axis=0)
        norm = float(mx.sqrt(mx.sum(mean * mean)).item())
        if norm < 1e-9:
            curved += 1  # normals cancel out → a closed/strongly-curved patch
            continue
        mean = mean / norm
        spread = float(mx.max(mx.degrees(mx.arccos(mx.clip(mx.sum(region * mean, axis=1), -1.0, 1.0)))).item())
        if spread > curved_spread_deg:
            curved += 1
    return {"tangent_regions": len(unique_labels), "curved_regions": curved}
