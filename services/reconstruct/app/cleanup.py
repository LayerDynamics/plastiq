"""Mesh cleanup before reconstruction (R6.2).

Generated/imported meshes are often messy — coincident-but-unwelded vertices, zero-area
slivers, duplicate faces, inconsistent winding, small holes. Cleaning them first means the
B-rep sewing welds correctly and watertight inputs actually close into solids, and gives
the later primitive-fitting stages (R6.3+) a sound mesh to segment. Uses trimesh's repair
toolkit (no extra native dependency).
"""

from __future__ import annotations

import numpy as np
import trimesh


def clean_mesh(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    fill_holes: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    """Weld coincident vertices, drop degenerate/duplicate faces, fix winding + normals,
    and optionally fill small holes. Returns the cleaned (vertices, faces)."""
    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=float),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    mesh.merge_vertices()  # weld coincident vertices so faces share edges (sewing needs this)
    mesh.update_faces(mesh.nondegenerate_faces())  # drop zero-area slivers
    mesh.update_faces(mesh.unique_faces())  # drop exact-duplicate triangles
    mesh.remove_unreferenced_vertices()
    trimesh.repair.fix_winding(mesh)  # consistent face winding
    trimesh.repair.fix_normals(mesh)  # outward-consistent normals
    if fill_holes:
        trimesh.repair.fill_holes(mesh)  # close small gaps so a near-watertight mesh solidifies

    return np.asarray(mesh.vertices, dtype=float), np.asarray(mesh.faces, dtype=np.int64)
