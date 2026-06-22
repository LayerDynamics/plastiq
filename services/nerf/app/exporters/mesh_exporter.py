"""Mesh exporter (N9, MLX→numpy boundary): a trained field → a triangle mesh.

Evaluate a scalar field on a dense `res³` grid over `[−bound, bound]³` and marching-cubes the chosen
isosurface (`skimage.measure.marching_cubes`) — the same extraction capture `sdf_mlx.extract_mesh`
uses, generalized over the two field kinds this service trains:

  * a **VolSDF/NeuS** surface field → the **signed-distance zero** level-set (`level=0`), and
  * a **density NeRF** field → a **density iso-surface** (`level=σ_threshold`); NeRF density is
    view-independent, so it is queried with an arbitrary fixed direction.

skimage works in numpy, so the grid is evaluated in MLX (batched) and brought across to numpy only for
the isosurface step — keeping the heavy field evals on Apple Silicon.
"""

from __future__ import annotations

from typing import Callable, Protocol

import mlx.core as mx
import numpy as np
from skimage import measure

_GRID_CHUNK = 65536  # grid points per field eval (bounds peak memory on large grids)


class SDFLike(Protocol):
    def sdf(self, x: mx.array) -> mx.array: ...


class DensityLike(Protocol):
    def __call__(self, positions: mx.array, directions: mx.array): ...


def _grid(bound: float, res: int) -> np.ndarray:
    lin = np.linspace(-bound, bound, res, dtype=np.float32)
    gx, gy, gz = np.meshgrid(lin, lin, lin, indexing="ij")
    return np.stack([gx, gy, gz], axis=-1).reshape(-1, 3)


def marching_cubes_field(
    scalar_fn: Callable[[mx.array], mx.array],
    *,
    bound: float = 1.6,
    res: int = 64,
    level: float = 0.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Marching-cubes the `level` isosurface of a scalar field. `scalar_fn` maps grid points
    `(M,3)` → values `(M,)`. Returns (vertices in world units `(V,3)`, faces `(F,3)`). Raises
    `ValueError` (from skimage) if the field never crosses `level`."""
    grid = _grid(bound, res)
    vals = [
        np.asarray(scalar_fn(mx.array(grid[i : i + _GRID_CHUNK]))).reshape(-1)
        for i in range(0, len(grid), _GRID_CHUNK)
    ]
    field = np.concatenate(vals).reshape(res, res, res)
    verts, faces, _, _ = measure.marching_cubes(field, level=level)
    verts = verts / (res - 1) * (2.0 * bound) - bound  # index space → world units
    return verts.astype(np.float32), faces.astype(np.int64)


def extract_sdf_mesh(field: SDFLike, *, bound: float = 1.6, res: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """Marching-cubes a signed-distance field's zero level-set (VolSDF/NeuS surface)."""
    return marching_cubes_field(lambda x: field.sdf(x).reshape(-1), bound=bound, res=res, level=0.0)


def extract_density_mesh(
    field: DensityLike, *, bound: float = 1.6, res: int = 64, level: float = 10.0
) -> tuple[np.ndarray, np.ndarray]:
    """Marching-cubes a density NeRF field at a density threshold. Density is view-independent, so a
    zero view direction is used for the query."""

    def density(x: mx.array) -> mx.array:
        sigma, _ = field(x, mx.zeros(x.shape))
        return sigma.reshape(-1)

    return marching_cubes_field(density, bound=bound, res=res, level=level)
