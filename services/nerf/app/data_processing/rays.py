"""Ray generation (N5, MLX): per-pixel world-space rays from a camera pose + pinhole intrinsics.

Internal camera convention: +z forward, the same pinhole as the capture service's geometry.py. A pixel
`(u,v)` → camera-space direction `[(u−cx)/fx, (v−cy)/fy, 1]`, rotated into the world by the c2w rotation;
the ray origin is the camera position (c2w translation). The synthetic fixture renders ground truth in
this exact convention, so training is self-consistent.
"""

from __future__ import annotations

import mlx.core as mx
import numpy as np

from ..utils.math import safe_normalize


def generate_rays(c2w, fx: float, fy: float, cx: float, cy: float, height: int, width: int):
    """`c2w` (4×4 camera-to-world) + intrinsics → (origins `(H*W,3)`, unit directions `(H*W,3)`), MLX."""
    c2w = c2w if isinstance(c2w, mx.array) else mx.array(np.asarray(c2w, dtype=np.float32))
    uu, vv = mx.meshgrid(mx.arange(width).astype(mx.float32), mx.arange(height).astype(mx.float32))
    dirs_cam = mx.stack([(uu - cx) / fx, (vv - cy) / fy, mx.ones_like(uu)], axis=-1).reshape(-1, 3)
    dirs_world = dirs_cam @ c2w[:3, :3].T  # R · d per row
    dirs_world = safe_normalize(dirs_world, axis=-1)  # eps-guarded (the helper that exists for this)
    origins = mx.broadcast_to(c2w[:3, 3][None, :], dirs_world.shape)
    return origins, dirs_world
