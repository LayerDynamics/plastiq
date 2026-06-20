"""Planar region detection (R6.3).

Groups coplanar + adjacent triangles into facets (via trimesh, which needs a graph
backend — scipy). Each planar facet collapses to ONE trimmed B-rep face in R6.4, instead
of many triangles — the core of a clean reconstruction for the flat regions of a part.
Triangles that belong to no facet are reported separately and stay faceted.
"""

from __future__ import annotations

import numpy as np
import trimesh


def planar_segments(
    vertices: np.ndarray,
    faces: np.ndarray,
) -> tuple[trimesh.Trimesh, list[np.ndarray], np.ndarray]:
    """Return (mesh, facets, leftover_face_indices). `facets` is a list of arrays of
    coplanar+adjacent face indices; `leftover` are face indices in no facet."""
    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=float),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    facets = [np.asarray(f, dtype=np.int64) for f in mesh.facets]
    covered = np.zeros(len(mesh.faces), dtype=bool)
    for f in facets:
        covered[f] = True
    leftover = np.nonzero(~covered)[0]
    return mesh, facets, leftover
