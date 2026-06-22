"""Training pipeline (N10): posed images → trained MLX field → mesh → GLB.

The orchestration the `/train` job runs end to end: parse the `transforms.json` poses + intrinsics,
generate rays for every view, train the chosen MLX model (VolSDF surface — the default, since its
zero level-set marching-cubes into a clean watertight mesh that feeds the mesh→B-rep reconstruct path
— or a density NeRF), then marching-cubes the field and export a GLB. Returns the `/jobs/{id}/result`
payload (the SPEC-11 §5 wire contract). Pure compute; the FastAPI layer only schedules it.
"""

from __future__ import annotations

import base64
import math

import mlx.core as mx
import numpy as np

from ..data_processing.dataparser import parse_transforms
from ..data_processing.rays import generate_rays
from ..exporters.glb_exporter import mesh_to_glb
from ..exporters.mesh_exporter import extract_density_mesh, extract_sdf_mesh
from ..models.neus import VolSDFModel
from ..models.vanilla_nerf import VanillaNeRF
from ..utils.config import FieldConfig, NerfConfig, SamplerConfig
from ..utils.seeding import make_key
from .trainer import Trainer

_SCENE_RADIUS = 1.5  # matches the field AABB default; bounds near/far + the marching-cubes grid.


def _psnr(pred: mx.array, target: mx.array) -> float:
    mse = float(mx.mean((pred - target) ** 2))
    return -10.0 * math.log10(max(mse, 1e-10))


def train_and_export(
    transforms: dict,
    images: np.ndarray,
    *,
    method: str = "neus",
    iters: int = 500,
    grid_res: int = 64,
    rays_per_batch: int = 1024,
    seed: int = 0,
) -> dict:
    """Train a field on posed views and export its surface. `transforms` is a transforms.json dict;
    `images` is `(N,H,W,3)` in [0,1] parallel to its frames. Returns the wire result dict."""
    out = parse_transforms(transforms, images)
    if len(out.poses) != len(images):
        raise ValueError(f"{len(out.poses)} poses but {len(images)} images")

    origins_l, dirs_l, target_l = [], [], []
    for i in range(len(out.poses)):
        o, d = generate_rays(out.poses[i], out.fx, out.fy, out.cx, out.cy, out.height, out.width)
        origins_l.append(o)
        dirs_l.append(d)
        target_l.append(mx.array(images[i].reshape(-1, 3).astype(np.float32)))
    origins, dirs, target = mx.concatenate(origins_l), mx.concatenate(dirs_l), mx.concatenate(target_l)

    cam_dist = float(np.linalg.norm(out.poses[:, :3, 3], axis=1).mean())  # mean camera distance to origin
    near = max(0.05, cam_dist - _SCENE_RADIUS)
    far = cam_dist + _SCENE_RADIUS
    cfg = NerfConfig(
        field=FieldConfig(hidden=64, layers=4),
        sampler=SamplerConfig(n_samples=48, near=near, far=far),
    )

    model = VolSDFModel(cfg, seed=seed) if method == "neus" else VanillaNeRF(cfg, seed=seed)
    Trainer(model, seed=seed).train(origins, dirs, target, iters=iters, rays_per_batch=rays_per_batch)

    # PSNR on a held-in ray sample (quality signal for the report).
    m = origins.shape[0]
    idx = mx.array(np.random.default_rng(seed + 2).integers(0, m, size=min(m, 4096)).astype(np.int32))
    pred = model.render_rays(mx.take(origins, idx, 0), mx.take(dirs, idx, 0), key=make_key(seed + 1))
    psnr = _psnr(pred, mx.take(target, idx, 0))

    grid_bound = _SCENE_RADIUS + 0.1
    if method == "neus":
        verts, faces = extract_sdf_mesh(model.field, bound=grid_bound, res=grid_res)
    else:
        verts, faces = extract_density_mesh(model, bound=grid_bound, res=grid_res)

    glb = mesh_to_glb(verts, faces)
    return {
        "glb_base64": base64.b64encode(glb).decode("ascii"),
        "vertices": int(verts.shape[0]),
        "faces": int(faces.shape[0]),
        "psnr": float(psnr),
        "method": method,
        "iters": int(iters),
    }
