"""MLX shape completion (M8): complete a PARTIAL point cloud into a full watertight mesh.

A conditional occupancy network (ONet-style): a PointNet encoder maps the partial scan to a latent,
and an occupancy decoder predicts inside/outside of the FULL shape for any query point conditioned on
that latent. Marching-cubes the predicted occupancy → completed mesh. Pure MLX — trains on Apple
Silicon (the M4 Max), no CUDA. The DLR-RM shape-completion repo is CUDA-only; this is a self-contained
implementation, not a port. See docs/adr/0008.

The demo trains on a synthetic family (hemisphere-masked sphere scans → the full ball); point it at a
real dataset (ShapeNet-style partial/full pairs) for general objects.
"""

from __future__ import annotations

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np

from .marching import marching_cubes_field

LATENT = 128


class CompletionNet(nn.Module):
    """PointNet encoder (per-point MLP → global max-pool → latent) + occupancy decoder
    ((query, latent) → inside/outside logit of the completed shape)."""

    def __init__(self, latent: int = LATENT, hidden: int = 128):
        super().__init__()
        self.enc1 = nn.Linear(3, hidden)
        self.enc2 = nn.Linear(hidden, hidden)
        self.enc3 = nn.Linear(hidden, latent)
        self.dec1 = nn.Linear(3 + latent, hidden)
        self.dec2 = nn.Linear(hidden, hidden)
        self.dec3 = nn.Linear(hidden, 1)

    def encode(self, points: mx.array) -> mx.array:
        """(B, N, 3) partial cloud → (B, latent). Max-pool makes it permutation-invariant."""
        h = nn.relu(self.enc1(points))
        h = nn.relu(self.enc2(h))
        h = self.enc3(h)
        return mx.max(h, axis=1)

    def decode(self, query: mx.array, latent: mx.array) -> mx.array:
        """query (B, M, 3) + latent (B, L) → occupancy logit (B, M)."""
        b, m, _ = query.shape
        z = mx.broadcast_to(latent[:, None, :], (b, m, latent.shape[-1]))
        h = mx.concatenate([query, z], axis=-1)
        h = nn.relu(self.dec1(h))
        h = nn.relu(self.dec2(h))
        return self.dec3(h)[..., 0]

    def __call__(self, points: mx.array, query: mx.array) -> mx.array:
        return self.decode(query, self.encode(points))


def _sample_sphere_batch(rng: np.random.Generator, batch: int, n_partial: int, n_query: int):
    """Synthetic (partial, query, full-occupancy) triples: a sphere of random radius with a random
    spherical cap removed (the 'missing' region), and occupancy of the FULL ball as the target."""
    partial = np.empty((batch, n_partial, 3), np.float32)
    query = np.empty((batch, n_query, 3), np.float32)
    occ = np.empty((batch, n_query), np.float32)
    for b in range(batch):
        r = float(rng.uniform(0.5, 1.0))
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        thresh = float(rng.uniform(-0.2, 0.3))  # how big a cap is missing
        pts: list[np.ndarray] = []
        while len(pts) < n_partial:
            x = rng.normal(size=(n_partial * 2, 3))
            x /= np.linalg.norm(x, axis=1, keepdims=True)
            for p in x[(x @ d) > thresh]:
                pts.append(p)
                if len(pts) >= n_partial:
                    break
        partial[b] = np.asarray(pts[:n_partial], np.float32) * r
        q = rng.uniform(-1.2, 1.2, size=(n_query, 3)).astype(np.float32)
        query[b] = q
        occ[b] = (np.linalg.norm(q, axis=1) < r).astype(np.float32)  # the FULL ball
    return partial, query, occ


def _bce_with_logits(logit: mx.array, target: mx.array) -> mx.array:
    """Numerically-stable binary cross-entropy on logits: softplus(logit) − target·logit."""
    return mx.mean(mx.logaddexp(mx.zeros_like(logit), logit) - target * logit)


def fit_completion(
    *, iters: int = 500, lr: float = 1e-3, batch: int = 16, n_partial: int = 256, n_query: int = 512, seed: int = 0
) -> CompletionNet:
    """Train the completion network on synthetic partial→full sphere pairs. Deterministic by seed."""
    mx.random.seed(seed)
    rng = np.random.default_rng(seed + 1)
    net = CompletionNet()  # init is deterministic given the mx seed above
    mx.eval(net.parameters())
    opt = optim.Adam(learning_rate=lr)

    def loss_fn(net: CompletionNet, p: mx.array, q: mx.array, o: mx.array) -> mx.array:
        return _bce_with_logits(net(p, q), o)

    loss_and_grad = nn.value_and_grad(net, loss_fn)
    for _ in range(iters):
        p, q, o = _sample_sphere_batch(rng, batch, n_partial, n_query)
        _, grads = loss_and_grad(net, mx.array(p), mx.array(q), mx.array(o))
        opt.update(net, grads)
        mx.eval(net.parameters(), opt.state)
    return net


def complete(net: CompletionNet, partial_points: np.ndarray, *, bound: float = 1.2, res: int = 48):
    """Complete a partial point cloud → (vertices, faces) of the inferred full shape. The decoder's
    occupancy logit is marching-cubed at 0 (logit 0 ↔ probability 0.5)."""
    latent = net.encode(mx.array(np.asarray(partial_points, dtype=np.float32)[None]))  # (1, L)
    # decode expects a batched query (1, m, 3); the shared helper feeds (m, 3) grid chunks.
    return marching_cubes_field(lambda q: net.decode(q[None], latent), bound=bound, res=res)
