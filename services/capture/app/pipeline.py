"""Capture pipeline: an oriented point cloud → a watertight mesh (GLB), via the MLX neural SDF.

The capture service's core: fit a Softplus/IGR SDF to points + normals (app.sdf_mlx, trained on the
M4 Max in MLX), marching-cubes the zero level-set, and export a GLB the browser imports as a MeshDoc
(then reconstruct → editable B-rep). Points/normals come from a depth scan (app.geometry, served as
`POST /points-from-depth`) or an external SfM/MVS (COLMAP). See docs/adr/0007.

Process-isolated entrypoints (``*_job``) return plain dicts and are picklable top-level callables so
``JobStore.submit_process`` can force-kill them on cancel (P0.2).
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass

import numpy as np
import trimesh

from .completion_mlx import CompletionNet, complete, fit_completion
from .sdf_mlx import extract_mesh, fit_sdf


@dataclass
class CaptureResult:
    mesh: trimesh.Trimesh
    vertices: int
    faces: int

    def to_glb(self) -> bytes:
        return self.mesh.export(file_type="glb")


def reconstruct_surface(
    points: np.ndarray,
    normals: np.ndarray,
    *,
    iters: int = 600,
    grid_res: int = 64,
    seed: int = 0,
) -> CaptureResult:
    """Fit an MLX SDF to the oriented point cloud and extract a mesh. The grid bound is the cloud's
    extent plus a margin so the surface sits inside the marching-cubes volume. Deterministic by seed."""
    p = np.asarray(points, dtype=np.float32)
    n = np.asarray(normals, dtype=np.float32)
    center = p.mean(axis=0)
    bound = float(np.abs(p - center).max()) * 1.4 + 1e-3

    net = fit_sdf(p - center, n, iters=iters, seed=seed)  # center the cloud at the origin for the init
    verts, faces = extract_mesh(net, bound=bound, res=grid_res)
    verts = verts + center  # back to world frame
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    return CaptureResult(mesh=mesh, vertices=len(verts), faces=len(faces))


def complete_partial(
    net: CompletionNet, partial_points: np.ndarray, *, grid_res: int = 48
) -> CaptureResult:
    """Complete a PARTIAL point cloud (a scan with holes) into a full watertight mesh, using a
    trained MLX completion network (M8). The cloud is centered AND normalized to unit scale for the
    network's frame (it is trained on radius~[0.5,1] spheres and completes over a fixed [-1.2,1.2]³
    grid — an arbitrary-scale scan, e.g. millimetres, would otherwise fall entirely outside the field
    and yield an empty/garbage mesh). The result is returned in world coordinates."""
    p = np.asarray(partial_points, dtype=np.float32)
    center = p.mean(axis=0)
    centered = p - center
    scale = float(np.abs(centered).max())
    if scale < 1e-6:
        raise ValueError("degenerate partial cloud (near-zero extent)")
    verts, faces = complete(net, centered / scale, bound=1.2, res=grid_res)
    verts = verts * scale + center  # undo the unit-scale normalization, back to world frame
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    return CaptureResult(mesh=mesh, vertices=len(verts), faces=len(faces))


def reconstruct_surface_job(
    points: list[list[float]],
    normals: list[list[float]],
    iters: int = 600,
    grid_res: int = 64,
) -> dict:
    """Picklable /capture worker: oriented cloud → result dict (process-isolated)."""
    res = reconstruct_surface(
        np.asarray(points, dtype=np.float32),
        np.asarray(normals, dtype=np.float32),
        iters=iters,
        grid_res=grid_res,
    )
    return {
        "glb_base64": base64.b64encode(res.to_glb()).decode("ascii"),
        "vertices": res.vertices,
        "faces": res.faces,
    }


def complete_partial_job(
    points: list[list[float]],
    grid_res: int = 48,
) -> dict:
    """Picklable /complete worker: partial cloud → result dict (process-isolated).

    Loads the completion checkpoint in the child (or trains the demo completer). Sets
    ``demo_weights`` so the client can refuse silent demo success (P0.3).
    """
    pts = np.asarray(points, dtype=np.float32)
    ckpt = os.environ.get("CAPTURE_COMPLETION_CHECKPOINT")
    demo = not bool(ckpt)
    if ckpt:
        import mlx.core as mx

        net = CompletionNet()
        net.load_weights(ckpt)
        mx.eval(net.parameters())
    else:
        net = fit_completion(iters=int(os.environ.get("CAPTURE_COMPLETION_ITERS", "500")), seed=0)
    res = complete_partial(net, pts, grid_res=grid_res)
    return {
        "glb_base64": base64.b64encode(res.to_glb()).decode("ascii"),
        "vertices": res.vertices,
        "faces": res.faces,
        "demo_weights": demo,
    }
