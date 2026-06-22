"""MLX neural-SDF surface reconstruction (M7).

A self-contained SIREN signed-distance network fit to an oriented point cloud (points + per-point
normals), trained with the implicit-geometric-regularization losses (Gropp et al. / IGR): surface
(f≈0 on the points), normal-alignment (∇f ≈ normal), and eikonal (|∇f|≈1). The zero level-set is then
marching-cubed into a watertight mesh. Pure MLX — runs and trains on Apple Silicon (the M4 Max), no
CUDA. See docs/adr/0007.

This is the surface-reconstruction half of photogrammetry: points/depth (+ normals, from
app.geometry.depth_to_normals) → mesh. The photos→points step (SfM/MVS) is COLMAP's job, upstream.
"""

from __future__ import annotations

import math

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np
from skimage import measure


class SDFNet(nn.Module):
    """An IGR-style Softplus MLP: 3D point → signed distance (scalar). The geometric initialization
    (Gropp et al. / Atzmon-Lipman) makes the network approximate the sphere SDF `‖x‖ − radius` at
    init — so the sign is correct from the start (negative inside) and training converges robustly,
    unlike a randomly-initialized SIREN. β sharpens the Softplus toward ReLU for near-metric gradients."""

    def __init__(self, hidden: int = 256, n_layers: int = 4, radius: float = 1.0, beta: float = 100.0, seed: int = 0):
        super().__init__()
        self.beta = beta
        dims = [3] + [hidden] * n_layers + [1]
        self.layers = [nn.Linear(dims[i], dims[i + 1]) for i in range(len(dims) - 1)]
        rng = np.random.default_rng(seed)
        last = len(self.layers) - 1
        for i, layer in enumerate(self.layers):
            out_dim, in_dim = layer.weight.shape
            if i == last:
                # geometric init: output ≈ ‖x‖ − radius  (correct sign: negative inside).
                w = rng.normal(math.sqrt(math.pi) / math.sqrt(in_dim), 1e-5, size=(out_dim, in_dim))
                layer.weight = mx.array(w.astype(np.float32))
                layer.bias = mx.array(np.array([-radius], dtype=np.float32))
            else:
                w = rng.normal(0.0, math.sqrt(2.0 / out_dim), size=(out_dim, in_dim))
                layer.weight = mx.array(w.astype(np.float32))
                layer.bias = mx.array(np.zeros(out_dim, dtype=np.float32))

    def __call__(self, x: mx.array) -> mx.array:
        h = x
        for layer in self.layers[:-1]:
            h = nn.softplus(self.beta * layer(h)) / self.beta
        return self.layers[-1](h)


def _sdf_grad(net: SDFNet, x: mx.array) -> mx.array:
    """∂f/∂x per row. f(x)[i] depends only on x[i], so the gradient of Σf wrt x is the per-row
    gradient — exactly the surface normal direction the SDF implies."""
    return mx.grad(lambda p: net(p).sum())(x)


def fit_sdf(
    points: np.ndarray,
    normals: np.ndarray,
    *,
    iters: int = 600,
    lr: float = 5e-4,
    eikonal_batch: int = 2048,
    lam_normal: float = 1.0,
    lam_eikonal: float = 0.1,
    seed: int = 0,
) -> SDFNet:
    """Fit a Softplus SDF (IGR losses) to an oriented point cloud. Deterministic given `seed`."""
    mx.random.seed(seed)
    rng = np.random.default_rng(seed + 1)
    p = np.asarray(points, dtype=np.float32)
    radius = float(np.linalg.norm(p - p.mean(axis=0), axis=1).mean())  # bounding-sphere scale for the init
    net = SDFNet(radius=radius, seed=seed)
    mx.eval(net.parameters())
    opt = optim.Adam(learning_rate=lr)

    pts = mx.array(np.asarray(points, dtype=np.float32))
    nrm = mx.array(np.asarray(normals, dtype=np.float32))
    lo = np.asarray(points, dtype=np.float32).min(axis=0) - 0.5
    hi = np.asarray(points, dtype=np.float32).max(axis=0) + 0.5

    def loss_fn(net: SDFNet, rand: mx.array) -> mx.array:
        f_surf = net(pts)  # (N,1) → want 0 on the surface
        g_surf = _sdf_grad(net, pts)  # (N,3) → want aligned with the outward normal
        l_surface = mx.abs(f_surf).mean()
        l_normal = (1.0 - (g_surf * nrm).sum(axis=1)).mean()  # 1 − cosine similarity
        g_rand = _sdf_grad(net, rand)
        l_eikonal = mx.square(mx.sqrt((g_rand * g_rand).sum(axis=1) + 1e-12) - 1.0).mean()
        return l_surface + lam_normal * l_normal + lam_eikonal * l_eikonal

    loss_and_grad = nn.value_and_grad(net, loss_fn)
    for _ in range(iters):
        rand = mx.array(rng.uniform(lo, hi, size=(eikonal_batch, 3)).astype(np.float32))
        _, grads = loss_and_grad(net, rand)
        opt.update(net, grads)
        mx.eval(net.parameters(), opt.state)
    return net


def extract_mesh(net: SDFNet, *, bound: float = 1.6, res: int = 64) -> tuple[np.ndarray, np.ndarray]:
    """Marching-cubes the SDF zero level-set over [−bound, bound]³ → (vertices, faces). Vertices are
    in world units. Raises ValueError (from skimage) if the field never crosses zero."""
    lin = np.linspace(-bound, bound, res, dtype=np.float32)
    gx, gy, gz = np.meshgrid(lin, lin, lin, indexing="ij")
    grid = np.stack([gx, gy, gz], axis=-1).reshape(-1, 3)
    vals = []
    for i in range(0, len(grid), 65536):
        vals.append(np.asarray(net(mx.array(grid[i : i + 65536]))).reshape(-1))
    field = np.concatenate(vals).reshape(res, res, res)
    verts, faces, _, _ = measure.marching_cubes(field, level=0.0)
    verts = verts / (res - 1) * (2.0 * bound) - bound  # index space → world units
    return verts.astype(np.float32), faces.astype(np.int64)
