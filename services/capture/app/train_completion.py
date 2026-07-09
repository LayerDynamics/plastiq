"""Train the M8 shape-completion network on REAL meshes → a `CAPTURE_COMPLETION_CHECKPOINT`.

The serving path (`app/main.py` `_completion_model`) loads `CAPTURE_COMPLETION_CHECKPOINT` when it is
set; this CLI is the producer of that checkpoint. It turns a directory of watertight meshes (any
format trimesh reads — STL/OBJ/GLB/PLY/…) into (partial-scan, query-points, occupancy) training
triples derived from the actual geometry:

- **partial scans** — surface points sampled uniformly over the mesh (area-weighted faces), then
  culled against a random view direction (`p·d > thresh`), the same hemisphere-style mask the
  synthetic sphere family in `completion_mlx` uses — the culled side is the "missing" region;
- **occupancy labels** — trimesh containment queries against the actual mesh (`mesh.contains`), so
  the target is the mesh's true inside/outside, never random labels.

Training reuses `CompletionNet` and the exact loss machinery of `fit_completion` (`_bce_with_logits`
+ Adam + `nn.value_and_grad`), saves weights via `save_weights`, and is deterministic by `--seed`.
`--resume` continues from a previously saved checkpoint. See docs/adr/0008.

    mamba run -n plastiq-capture python -m app.train_completion ./meshes \
        --checkpoint completion.safetensors --iters 2000 --seed 0

Then serve it:  CAPTURE_COMPLETION_CHECKPOINT=completion.safetensors uvicorn app.main:app --port 8001
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np
import trimesh

from .completion_mlx import CompletionNet, _bce_with_logits
from .logging_setup import setup_logging

logger = logging.getLogger(__name__)

# The completion grid complete()/complete_partial() marching-cubes over — queries are drawn from the
# same volume so the network is supervised everywhere it will be evaluated at inference.
_QUERY_BOUND = 1.2


def load_meshes(mesh_dir: str | Path) -> list[trimesh.Trimesh]:
    """Load every watertight mesh under `mesh_dir`, normalized to the network's frame: centered on
    the bounding-box centre, max |coord| = 1 (the synthetic sphere family's scale). Unloadable files
    and non-watertight meshes are skipped with a warning — occupancy needs a well-defined inside."""
    meshes: list[trimesh.Trimesh] = []
    for path in sorted(Path(mesh_dir).iterdir()):
        if not path.is_file():
            continue
        try:
            mesh = trimesh.load(path, force="mesh")
        except Exception as e:  # noqa: BLE001 — a non-mesh file in the directory is skipped, not fatal
            logger.warning("skipping %s (not a loadable mesh: %s)", path.name, e)
            continue
        if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
            logger.warning("skipping %s (no triangles)", path.name)
            continue
        if not mesh.is_watertight:
            logger.warning("skipping %s (not watertight — occupancy labels need a defined inside)", path.name)
            continue
        mesh = mesh.copy()
        mesh.apply_translation(-(mesh.bounds[0] + mesh.bounds[1]) / 2.0)
        mesh.apply_scale(1.0 / float(np.abs(mesh.vertices).max()))
        meshes.append(mesh)
    if not meshes:
        raise ValueError(f"no watertight meshes found in {mesh_dir}")
    return meshes


def _sample_surface(mesh: trimesh.Trimesh, n: int, rng: np.random.Generator) -> np.ndarray:
    """`n` points uniform on the mesh surface: area-weighted face choice + uniform barycentric
    coordinates, drawn from OUR rng so the dataset is deterministic by seed (trimesh's own samplers
    use their own randomness)."""
    faces = rng.choice(len(mesh.faces), size=n, p=mesh.area_faces / mesh.area_faces.sum())
    tri = mesh.triangles[faces]  # (n, 3, 3)
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1.0  # reflect samples outside the triangle back inside
    u[flip], v[flip] = 1.0 - u[flip], 1.0 - v[flip]
    pts = tri[:, 0] + u[:, None] * (tri[:, 1] - tri[:, 0]) + v[:, None] * (tri[:, 2] - tri[:, 0])
    return pts.astype(np.float32)


def _partial_view(mesh: trimesh.Trimesh, rng: np.random.Generator, n_partial: int) -> np.ndarray:
    """A partial 'scan' of the mesh: surface samples culled against a random view direction — only
    points with `p·d > thresh` are 'seen', the far side is the missing region (the hemisphere-style
    mask of `completion_mlx._sample_sphere_batch`, applied to real geometry). The threshold relaxes
    if a cut leaves (almost) no surface visible."""
    d = rng.normal(size=3)
    d /= np.linalg.norm(d)
    thresh = float(rng.uniform(-0.2, 0.3))  # how big a region is missing
    pts: list[np.ndarray] = []
    while len(pts) < n_partial:
        s = _sample_surface(mesh, n_partial * 2, rng)
        kept = s[(s @ d) > thresh]
        if len(kept) == 0:
            thresh -= 0.1  # the cut removed everything — relax until some surface is seen
            continue
        pts.extend(kept)
    return np.asarray(pts[:n_partial], np.float32)


def build_dataset(
    meshes: list[trimesh.Trimesh], *, samples: int, n_partial: int = 256, n_query: int = 512, seed: int = 0
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(partial, query, occupancy) triples from real geometry: a partial view of a random mesh at a
    random scale in [0.5, 1] (the sphere family's radius range), query points uniform over the
    completion grid's [−1.2, 1.2]³, and occupancy labels from trimesh containment queries evaluated
    in the mesh's own frame. Shapes: (S, P, 3), (S, Q, 3), (S, Q). Deterministic by seed."""
    rng = np.random.default_rng(seed)
    partial = np.empty((samples, n_partial, 3), np.float32)
    query = np.empty((samples, n_query, 3), np.float32)
    occ = np.empty((samples, n_query), np.float32)
    for i in range(samples):
        mesh = meshes[int(rng.integers(len(meshes)))]
        scale = float(rng.uniform(0.5, 1.0))
        partial[i] = _partial_view(mesh, rng, n_partial) * scale
        q = rng.uniform(-_QUERY_BOUND, _QUERY_BOUND, size=(n_query, 3)).astype(np.float32)
        query[i] = q
        occ[i] = mesh.contains(q / scale).astype(np.float32)  # the TRUE inside of the scaled mesh
    return partial, query, occ


def train_completion(
    dataset: tuple[np.ndarray, np.ndarray, np.ndarray],
    *,
    iters: int = 2000,
    lr: float = 1e-3,
    batch: int = 16,
    seed: int = 0,
    resume: str | Path | None = None,
    checkpoint: str | Path | None = None,
    save_every: int = 0,
) -> tuple[CompletionNet, list[float]]:
    """Train `CompletionNet` on a real-geometry dataset with the same loss machinery as
    `fit_completion` (`_bce_with_logits` + Adam). Deterministic by seed. `resume` loads a checkpoint
    before training; `checkpoint` + `save_every` write intermediate saves (via `save_weights`) so a
    long run survives interruption. Returns (net, per-iteration losses)."""
    partial, query, occ = dataset
    mx.random.seed(seed)
    rng = np.random.default_rng(seed + 1)
    net = CompletionNet()  # init is deterministic given the mx seed above
    mx.eval(net.parameters())
    if resume:
        net.load_weights(str(resume))
        mx.eval(net.parameters())
        logger.info("resumed weights from %s", resume)
    opt = optim.Adam(learning_rate=lr)

    def loss_fn(net: CompletionNet, p: mx.array, q: mx.array, o: mx.array) -> mx.array:
        return _bce_with_logits(net(p, q), o)

    loss_and_grad = nn.value_and_grad(net, loss_fn)
    losses: list[float] = []
    log_every = max(1, iters // 10)
    for it in range(iters):
        idx = rng.integers(0, len(partial), size=batch)
        loss, grads = loss_and_grad(net, mx.array(partial[idx]), mx.array(query[idx]), mx.array(occ[idx]))
        opt.update(net, grads)
        mx.eval(net.parameters(), opt.state)
        losses.append(float(loss))
        if (it + 1) % log_every == 0:
            logger.info("iter %d/%d  loss %.4f", it + 1, iters, losses[-1])
        if checkpoint and save_every and (it + 1) % save_every == 0 and (it + 1) < iters:
            net.save_weights(str(checkpoint))
            logger.info("checkpoint saved to %s at iter %d", checkpoint, it + 1)
    return net, losses


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="python -m app.train_completion",
        description="Train the shape-completion network on a directory of watertight meshes and save "
        "a checkpoint the service loads via CAPTURE_COMPLETION_CHECKPOINT.",
    )
    parser.add_argument("mesh_dir", help="directory of watertight meshes (any format trimesh reads)")
    parser.add_argument(
        "--checkpoint", required=True, help="output weights path (.safetensors or .npz, via save_weights)"
    )
    parser.add_argument("--iters", type=int, default=2000, help="training iterations (default 2000)")
    parser.add_argument("--seed", type=int, default=0, help="dataset + training seed (default 0)")
    parser.add_argument("--resume", default=None, help="checkpoint to continue training from")
    parser.add_argument("--samples", type=int, default=256, help="dataset triples to pregenerate (default 256)")
    parser.add_argument("--batch", type=int, default=16, help="batch size (default 16)")
    parser.add_argument("--n-partial", type=int, default=256, help="points per partial scan (default 256)")
    parser.add_argument("--n-query", type=int, default=512, help="occupancy queries per triple (default 512)")
    parser.add_argument("--lr", type=float, default=1e-3, help="Adam learning rate (default 1e-3)")
    parser.add_argument(
        "--save-every", type=int, default=0, help="also save the checkpoint every N iters (0 = final only)"
    )
    args = parser.parse_args(argv)

    setup_logging()
    meshes = load_meshes(args.mesh_dir)
    logger.info("loaded %d watertight mesh(es) from %s", len(meshes), args.mesh_dir)
    dataset = build_dataset(
        meshes, samples=args.samples, n_partial=args.n_partial, n_query=args.n_query, seed=args.seed
    )
    logger.info(
        "dataset built: %d triples (%d partial points, %d queries each; %.1f%% occupied)",
        args.samples,
        args.n_partial,
        args.n_query,
        100.0 * float(dataset[2].mean()),
    )
    net, losses = train_completion(
        dataset,
        iters=args.iters,
        lr=args.lr,
        batch=args.batch,
        seed=args.seed,
        resume=args.resume,
        checkpoint=args.checkpoint,
        save_every=args.save_every,
    )
    net.save_weights(str(args.checkpoint))
    logger.info(
        "final checkpoint saved to %s (last loss %.4f) — serve it via CAPTURE_COMPLETION_CHECKPOINT",
        args.checkpoint,
        losses[-1] if losses else float("nan"),
    )


if __name__ == "__main__":
    main()
