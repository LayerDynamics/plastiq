"""Capture-service mesh remesh / decimate — the heavy pure-geometry ops the sculpt lane
optionally delegates (§16 mesh lane: "heavy remesh optionally delegated to the capture
service ... following its spawn-isolated job pattern").

Two modes over a triangle mesh, both returning a GLB the browser imports as a MeshDoc:

  • ``remesh``   — isotropic refinement toward a target edge length (trimesh's built-in
                   ``subdivide_to_size``: split every edge longer than the target).
  • ``decimate`` — reduce to a target triangle count. Uses trimesh's quadric decimation
                   when a backend is available, else a self-contained numpy
                   vertex-clustering decimation (grid-snap + weld) so the endpoint never
                   depends on an optional native simplifier.

``remesh_job`` is a picklable, top-level callable that returns a plain dict, so
``JobStore.submit_process`` can force-kill it on cancel (P0.2) exactly like the SDF fit.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import numpy as np
import trimesh


@dataclass
class RemeshResult:
    mesh: trimesh.Trimesh
    vertices: int
    faces: int

    def to_glb(self) -> bytes:
        return self.mesh.export(file_type="glb")


def _cluster_decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """Self-contained vertex-clustering decimation (no native simplifier dependency).

    Snap vertices onto a uniform grid, weld coincident cells to their mean, remap the
    triangles, and drop the degenerate/duplicate faces. The grid resolution is searched
    (coarse→fine) until the face count first drops to the target, so the result is the
    finest clustering that still meets it. Deterministic for a given input + target.
    """
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    lo = verts.min(axis=0)
    extent = float((verts.max(axis=0) - lo).max()) or 1.0

    best: trimesh.Trimesh | None = None
    for res in (8, 12, 16, 24, 32, 48, 64, 96, 128):
        cell = extent / res
        keys = np.floor((verts - lo) / cell).astype(np.int64)
        # Map each occupied cell → a new vertex index; representative = mean of its verts.
        uniq, inverse = np.unique(keys, axis=0, return_inverse=True)
        new_verts = np.zeros((len(uniq), 3), dtype=np.float64)
        counts = np.zeros(len(uniq), dtype=np.int64)
        np.add.at(new_verts, inverse, verts)
        np.add.at(counts, inverse, 1)
        new_verts /= counts[:, None]
        new_faces = inverse[faces]
        # drop degenerate triangles (two corners share a cluster)
        good = (
            (new_faces[:, 0] != new_faces[:, 1])
            & (new_faces[:, 1] != new_faces[:, 2])
            & (new_faces[:, 0] != new_faces[:, 2])
        )
        new_faces = new_faces[good]
        if len(new_faces) == 0:
            continue
        # drop duplicate faces (same corner set)
        sorted_faces = np.sort(new_faces, axis=1)
        _, keep = np.unique(sorted_faces, axis=0, return_index=True)
        new_faces = new_faces[np.sort(keep)]
        candidate = trimesh.Trimesh(vertices=new_verts, faces=new_faces, process=False)
        best = candidate
        if len(new_faces) >= target_faces:
            break
    return best if best is not None else mesh


def remesh_surface(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    mode: str = "remesh",
    target_edge_length: float | None = None,
    target_faces: int | None = None,
    target_ratio: float = 0.5,
) -> RemeshResult:
    """Remesh or decimate a triangle mesh. `mode` is "remesh" or "decimate"."""
    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )
    if mode == "remesh":
        edge = target_edge_length
        if edge is None or edge <= 0:
            # Default target: half the current mean edge length (a genuine refinement).
            e = mesh.edges_unique_length
            edge = float(np.mean(e)) * 0.5 if len(e) else 1.0
        out = mesh.subdivide_to_size(max_edge=edge)
    elif mode == "decimate":
        target = target_faces if target_faces is not None else max(4, int(len(mesh.faces) * target_ratio))
        out = None
        simplify = getattr(mesh, "simplify_quadric_decimation", None)
        if simplify is not None:
            try:
                out = simplify(target)  # trimesh ≥ backend-available quadric decimation
            except Exception:  # noqa: BLE001 — fall back to the self-contained clusterer
                out = None
        if out is None or len(out.faces) == 0:
            out = _cluster_decimate(mesh, target)
    else:
        raise ValueError(f"unknown remesh mode {mode!r} (expected 'remesh' or 'decimate')")

    return RemeshResult(mesh=out, vertices=len(out.vertices), faces=len(out.faces))


def remesh_job(
    vertices: list[list[float]],
    faces: list[list[int]],
    mode: str = "remesh",
    target_edge_length: float | None = None,
    target_faces: int | None = None,
    target_ratio: float = 0.5,
) -> dict:
    """Picklable /remesh worker: mesh → result dict (process-isolated, force-killable)."""
    res = remesh_surface(
        np.asarray(vertices, dtype=np.float64),
        np.asarray(faces, dtype=np.int64),
        mode=mode,
        target_edge_length=target_edge_length,
        target_faces=target_faces,
        target_ratio=target_ratio,
    )
    return {
        "glb_base64": base64.b64encode(res.to_glb()).decode("ascii"),
        "vertices": res.vertices,
        "faces": res.faces,
    }
