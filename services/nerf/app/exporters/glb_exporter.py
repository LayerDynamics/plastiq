"""GLB exporter (N9): triangle mesh / point cloud → a binary glTF (GLB) blob.

The GLB is exactly what the browser side consumes — base64-encoded in the `/jobs/{id}/result`
response, imported as a `MeshDoc`, then fed to the mesh→B-rep reconstruct path. Mirrors capture
`CaptureResult.to_glb` (`trimesh … .export(file_type="glb")`); `process=False` keeps the vertices/
faces exactly as the marching cubes produced them (no welding/reordering).
"""

from __future__ import annotations

import numpy as np
import trimesh


def mesh_to_glb(vertices: np.ndarray, faces: np.ndarray) -> bytes:
    """(vertices `(V,3)`, faces `(F,3)`) → a GLB byte blob."""
    mesh = trimesh.Trimesh(vertices=np.asarray(vertices), faces=np.asarray(faces), process=False)
    return mesh.export(file_type="glb")


def pointcloud_to_glb(points: np.ndarray, colors: np.ndarray | None = None) -> bytes:
    """A point cloud `(N,3)` (optional per-point RGB/RGBA `colors`) → a GLB byte blob. Useful for
    exporting the raw field samples / a sparse reconstruction alongside the surface mesh."""
    cloud = trimesh.PointCloud(vertices=np.asarray(points), colors=colors)
    return trimesh.Scene(cloud).export(file_type="glb")
