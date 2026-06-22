"""Mesh-side feature recognition (M2c) — the clean-room tangent-adjacency idea from the
@plastiq/cad selectors, computed over a triangle mesh.

Groups triangles into **tangent-connected regions** (faces joined across smooth, low-dihedral edges)
and flags which regions are **curved**. This is a structural fingerprint of the input mesh — a box
is 6 flat regions, a cylinder is one curved lateral + 2 flat caps, an organic blob is many — that
the reconstruction report surfaces for honest UX (NFR-4) and that a fitter could use to pre-group
regions before fitting. Deterministic (fixed dihedral threshold + scipy connected-components), so it
fits NFR-2. Implemented from the standard dihedral test, not from BRepNet's source (docs/adr/0002).
"""

from __future__ import annotations

import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

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


def group_tangent_regions(
    vertices: np.ndarray, faces: np.ndarray, smooth_angle_deg: float = SMOOTH_ANGLE_DEG
) -> np.ndarray:
    """Label each triangle with its tangent-connected region id (connected components over
    smooth — low-dihedral — face adjacencies). Coplanar triangles of one flat face share a region;
    faces meeting at a sharp edge get distinct regions. Deterministic."""
    mesh = _mesh(vertices, faces)
    n = len(mesh.faces)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    adjacency = mesh.face_adjacency  # (m, 2) pairs of triangles sharing an edge
    angles = mesh.face_adjacency_angles  # (m,) dihedral angle (radians) across that edge
    smooth = angles < np.radians(smooth_angle_deg)
    pairs = adjacency[smooth]
    if len(pairs):
        data = np.ones(len(pairs), dtype=np.int8)
        graph = coo_matrix((data, (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    else:
        graph = coo_matrix((n, n), dtype=np.int8)
    _, labels = connected_components(graph, directed=False)
    return labels.astype(np.int64)


def recognize(
    vertices: np.ndarray,
    faces: np.ndarray,
    smooth_angle_deg: float = SMOOTH_ANGLE_DEG,
    curved_spread_deg: float = CURVED_SPREAD_DEG,
) -> dict[str, int]:
    """Recognise the part's tangent structure: how many tangent-connected regions it has, and how
    many of those are curved (non-planar). Deterministic."""
    mesh = _mesh(vertices, faces)
    if len(mesh.faces) == 0:
        return {"tangent_regions": 0, "curved_regions": 0}
    labels = group_tangent_regions(vertices, faces, smooth_angle_deg)
    normals = np.asarray(mesh.face_normals, dtype=float)
    curved = 0
    for r in np.unique(labels):
        region = normals[labels == r]
        mean = region.mean(axis=0)
        norm = np.linalg.norm(mean)
        if norm < 1e-9:
            curved += 1  # normals cancel out → a closed/strongly-curved patch
            continue
        mean /= norm
        spread = np.degrees(np.arccos(np.clip(region @ mean, -1.0, 1.0))).max()
        if spread > curved_spread_deg:
            curved += 1
    return {"tangent_regions": int(len(np.unique(labels))), "curved_regions": int(curved)}
