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


def _holdout_split(m: int, seed: int, *, max_holdout: int = 4096) -> tuple[np.ndarray, np.ndarray]:
    """Seeded, disjoint (train, held-out) split of `m` ray indices. ~10% of the rays (capped at
    `max_holdout`, at least 1 when m > 1) are held out BEFORE training and never seen by the trainer;
    the reported PSNR is evaluated on them, so it is a genuine held-out quality signal."""
    n_hold = int(min(max_holdout, max(1, m // 10), max(m - 1, 0)))
    rng = np.random.default_rng(seed + 2)
    hold = np.sort(rng.choice(m, size=n_hold, replace=False)).astype(np.int32)
    mask = np.ones(m, dtype=bool)
    mask[hold] = False
    train = np.nonzero(mask)[0].astype(np.int32)
    return train, hold


def train_and_export(
    transforms: dict,
    images: np.ndarray,
    *,
    method: str = "neus",
    iters: int = 500,
    grid_res: int = 64,
    rays_per_batch: int = 1024,
    encoding: str = "frequency",
    # None → method default (neus: hierarchical PDF on; nerf: off) — T28.
    importance_samples: int | None = None,
    background: tuple[float, float, float] | None = None,
    masks: np.ndarray | None = None,
    # Production defaults for neus (T26/M3): learnable β + schedule/clip on; white bg
    # when unset so empty rays match common synthetic/white-backdrop captures.
    learnable_beta: bool | None = None,
    grad_clip: float | None = None,
    warmup_frac: float | None = None,
    lr_final_frac: float | None = None,
    seed: int = 0,
) -> dict:
    """Train a field on posed views and export its surface. `transforms` is a transforms.json dict;
    `images` is `(N,H,W,3)` in [0,1] parallel to its frames. Returns the wire result dict.

    `encoding` picks the NeRF position encoding (`frequency` | `hashgrid`, `method="nerf"` only —
    the neus SDF trunk consumes raw coordinates by design, so `hashgrid` there is a ValueError, not
    a silent no-op); `importance_samples > 0` adds the fine PDF (hierarchical) sampling pass, which
    both methods support."""
    if encoding not in ("frequency", "hashgrid"):
        raise ValueError(f"unknown encoding {encoding!r} (expected 'frequency' or 'hashgrid')")
    if encoding == "hashgrid" and method != "nerf":
        raise ValueError(
            "encoding 'hashgrid' requires method 'nerf' — the 'neus' SDF trunk consumes raw "
            "coordinates by design (geometric init), so it has no position encoding to swap"
        )
    # Method defaults for hierarchical sampling applied after this check (T28).
    if importance_samples is not None and importance_samples < 0:
        raise ValueError("importance_samples must be >= 0")
    out = parse_transforms(transforms, images)
    if len(out.poses) != len(images):
        raise ValueError(f"{len(out.poses)} poses but {len(images)} images")

    origins_l, dirs_l, target_l = [], [], []
    for i in range(len(out.poses)):
        o, d = generate_rays(out.poses[i], out.fx, out.fy, out.cx, out.cy, out.height, out.width)
        origins_l.append(o)
        dirs_l.append(d)
        rgb_i = images[i].reshape(-1, 3).astype(np.float32)
        if masks is not None:
            rgb_i = np.concatenate([rgb_i, masks[i].reshape(-1, 1).astype(np.float32)], axis=1)  # +alpha
        target_l.append(mx.array(rgb_i))
    origins, dirs, target = mx.concatenate(origins_l), mx.concatenate(dirs_l), mx.concatenate(target_l)

    cam_dist = float(np.linalg.norm(out.poses[:, :3, 3], axis=1).mean())  # mean camera distance to origin
    near = max(0.05, cam_dist - _SCENE_RADIUS)
    far = cam_dist + _SCENE_RADIUS
    # Neus production defaults (T26/T28); vanilla nerf keeps opt-in schedule (None → no-op).
    if method == "neus":
        if learnable_beta is None:
            learnable_beta = True
        if grad_clip is None:
            grad_clip = 1.0
        if warmup_frac is None:
            warmup_frac = 0.05
        if lr_final_frac is None:
            lr_final_frac = 0.1
        if background is None:
            background = (1.0, 1.0, 1.0)
        if importance_samples is None:
            importance_samples = 32  # hierarchical PDF fine pass (proposal-style)
    else:
        if learnable_beta is None:
            learnable_beta = False
        if warmup_frac is None:
            warmup_frac = 0.0
        if lr_final_frac is None:
            lr_final_frac = 1.0
        if importance_samples is None:
            importance_samples = 0

    cfg = NerfConfig(
        # use_hashgrid is only read by the NeRFField (method="nerf") — the hashgrid+neus combination
        # was rejected above, so the flag is never set where it would be silently ignored.
        field=FieldConfig(hidden=64, layers=4, use_hashgrid=encoding == "hashgrid"),
        sampler=SamplerConfig(n_samples=48, near=near, far=far, importance_samples=importance_samples),
        background=background,
    )

    # Deterministic held-out split: ~10% of the rays (seeded, capped) are excluded from the training
    # set entirely and kept for the reported PSNR.
    train_idx_np, hold_idx_np = _holdout_split(origins.shape[0], seed)
    train_idx, hold_idx = mx.array(train_idx_np), mx.array(hold_idx_np)
    hold_o, hold_d, hold_t = mx.take(origins, hold_idx, 0), mx.take(dirs, hold_idx, 0), mx.take(target, hold_idx, 0)
    origins, dirs, target = mx.take(origins, train_idx, 0), mx.take(dirs, train_idx, 0), mx.take(target, train_idx, 0)

    model = (VolSDFModel(cfg, learnable_beta=bool(learnable_beta), seed=seed) if method == "neus"
             else VanillaNeRF(cfg, seed=seed))
    # Tiny scenes (a handful of low-res views) have so few rays that subsampling them with replacement
    # only injects gradient noise — a short run then converges or collapses on the luck of the batch
    # draw. Train full-batch when the training set is within 2× the requested batch; real captures
    # (m ≫ batch) keep the requested batch size.
    m_train = int(origins.shape[0])
    batch = m_train if m_train <= 2 * rays_per_batch else rays_per_batch
    Trainer(model, seed=seed).train(origins, dirs, target, iters=iters, rays_per_batch=batch,
                                    grad_clip=grad_clip, warmup_frac=float(warmup_frac),
                                    lr_final_frac=float(lr_final_frac))

    # PSNR on the held-out rays (never trained on) — the genuine held-out quality signal for the report.
    pred = model.render_rays(hold_o, hold_d, key=make_key(seed + 1))
    psnr = _psnr(pred, hold_t[:, :3])  # RGB only (targets may carry a 4th alpha/mask channel)

    grid_bound = _SCENE_RADIUS + 0.1
    if method == "neus":
        verts, faces = extract_sdf_mesh(model.field, bound=grid_bound, res=grid_res)
    else:
        # the NeRFField (density, rgb) = field(positions, directions) — not the model wrapper. The
        # density iso uses extract_density_mesh's fixed default level; a NeRF density field has no
        # guaranteed scale, so for arbitrary scenes this threshold may need tuning (neus is the robust
        # default). The unit-scaled synthetic scene crosses it.
        verts, faces = extract_density_mesh(model.field, bound=grid_bound, res=grid_res)

    glb = mesh_to_glb(verts, faces)
    return {
        "glb_base64": base64.b64encode(glb).decode("ascii"),
        "vertices": int(verts.shape[0]),
        "faces": int(faces.shape[0]),
        "psnr": float(psnr),
        "method": method,
        "iters": int(iters),
        # The effective sampling/encoding settings the served model actually trained with (additive
        # to the frozen SPEC-11 §5 keys above).
        "encoding": encoding,
        "importance_samples": int(importance_samples),
    }
