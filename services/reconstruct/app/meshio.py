"""Load a GLB/glTF (bytes) into (vertices, faces) numpy arrays.

The MeshDoc stores its model as an inline GLB; the service decodes that and hands the
triangle soup to the reconstruction pipeline. Scene transforms are baked into world-space
coordinates (matching importGltf on the client), and a multi-mesh scene is concatenated.
"""

from __future__ import annotations

import io

import numpy as np
import trimesh


def load_mesh(data: bytes, file_type: str = "glb") -> tuple[np.ndarray, np.ndarray]:
    """Decode mesh bytes → (vertices (N,3) float, faces (M,3) int64). Raises on no geometry."""
    obj = trimesh.load(io.BytesIO(data), file_type=file_type, process=False)
    mesh = _as_single_mesh(obj)
    if mesh is None or len(mesh.faces) == 0:
        raise ValueError("mesh contained no triangle geometry")
    vertices = np.asarray(mesh.vertices, dtype=float)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    return vertices, faces


def _as_single_mesh(obj: object) -> trimesh.Trimesh | None:
    if isinstance(obj, trimesh.Trimesh):
        return obj
    if isinstance(obj, trimesh.Scene):
        if len(obj.geometry) == 0:
            return None
        # Concatenate every mesh in the scene with world transforms baked in.
        return obj.to_geometry() if hasattr(obj, "to_geometry") else obj.dump(concatenate=True)
    return None
