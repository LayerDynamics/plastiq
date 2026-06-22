"""Shared marching-cubes extraction for the capture service (MLX field → mesh).

Both the SDF surface fit (`sdf_mlx.extract_mesh`) and the occupancy completion (`completion_mlx.complete`)
evaluate a scalar field on a dense grid and marching-cubes the same `level=0` isosurface (the SDF zero
level-set; the completion logit-0 ↔ probability-0.5 boundary). This factors that out so the grid eval,
chunking, world-rescale, and — importantly — the no-crossing guard live in ONE place.
"""

from __future__ import annotations

from collections.abc import Callable

import mlx.core as mx
import numpy as np
from skimage import measure

_CHUNK = 65536  # grid points per field eval (bounds peak memory on large grids)


def marching_cubes_field(
    eval_fn: Callable[[mx.array], mx.array], *, bound: float, res: int, level: float = 0.0
) -> tuple[np.ndarray, np.ndarray]:
    """Evaluate `eval_fn` on a `res³` grid over `[−bound, bound]³` and marching-cubes the `level`
    isosurface → (vertices in world units `(V,3)`, faces `(F,3)`). `eval_fn` maps grid points `(m,3)`
    → values `(m,)` (or `(m,1)`; it is flattened). Raises a CLEAR `ValueError` when the field never
    crosses `level` (a single-signed field has no surface — surface outside the bound, or a bad
    fit/scale), instead of skimage's opaque "Surface level must be within volume data range"."""
    lin = np.linspace(-bound, bound, res, dtype=np.float32)
    gx, gy, gz = np.meshgrid(lin, lin, lin, indexing="ij")
    grid = np.stack([gx, gy, gz], axis=-1).reshape(-1, 3)
    vals = [
        np.asarray(eval_fn(mx.array(grid[i : i + _CHUNK]))).reshape(-1) for i in range(0, len(grid), _CHUNK)
    ]
    field = np.concatenate(vals).reshape(res, res, res)
    if not (field.min() < level < field.max()):
        raise ValueError(
            f"no {level} crossing in the marching-cubes volume (field range "
            f"[{field.min():.3g}, {field.max():.3g}]) — the surface is likely outside the grid bound, "
            "or the fit/input scale is off"
        )
    verts, faces, _, _ = measure.marching_cubes(field, level=level)
    verts = verts / (res - 1) * (2.0 * bound) - bound  # index space → world units
    return verts.astype(np.float32), faces.astype(np.int64)
