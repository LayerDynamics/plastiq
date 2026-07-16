"""M8 — the completion-training CLI (app/train_completion.py): REAL-geometry training triples
(partial views by view-direction culling of surface samples, occupancy labels from trimesh
containment queries against watertight meshes), checkpoint save→load via save_weights, resume, and
the CAPTURE_COMPLETION_CHECKPOINT serving branch of app.main._completion_model. Real MLX training on
Apple Silicon (the M4 Max) — tiny nets/iters so the suite stays fast. See docs/adr/0008."""

import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("mlx.core")
pytest.importorskip("skimage")

import mlx.core as mx  # noqa: E402
import trimesh  # noqa: E402

from app.completion_mlx import CompletionNet  # noqa: E402
from app.train_completion import build_dataset, load_meshes, main, train_completion  # noqa: E402

_SERVICE_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def sphere_dir(tmp_path: Path) -> Path:
    d = tmp_path / "spheres"
    d.mkdir()
    trimesh.creation.icosphere(subdivisions=2, radius=1.0).export(d / "sphere.stl")
    return d


@pytest.fixture()
def mesh_dir(tmp_path: Path) -> Path:
    d = tmp_path / "meshes"
    d.mkdir()
    trimesh.creation.icosphere(subdivisions=1, radius=1.0).export(d / "sphere.stl")
    trimesh.creation.box(extents=(1.6, 1.2, 0.8)).export(d / "box.stl")
    return d


def _tiny_dataset(mesh_dir: Path, *, samples: int = 8, seed: int = 0):
    return build_dataset(load_meshes(mesh_dir), samples=samples, n_partial=64, n_query=64, seed=seed)


def test_dataset_triples_derive_from_the_real_geometry(sphere_dir: Path):
    # a sphere-only dataset makes the geometry checks exact: after load_meshes normalization the
    # sphere radius is ~1 and per-sample scales are in [0.5, 1].
    meshes = load_meshes(sphere_dir)
    partial, query, occ = build_dataset(meshes, samples=6, n_partial=96, n_query=160, seed=0)
    assert partial.shape == (6, 96, 3) and query.shape == (6, 160, 3) and occ.shape == (6, 160)

    radii = np.linalg.norm(partial, axis=2)  # (S, P)
    for i in range(len(partial)):
        # partial points lie ON the surface (a thin spherical shell), not scattered in the volume
        assert (radii[i].max() - radii[i].min()) / radii[i].max() < 0.15
        # and the scan is genuinely PARTIAL: a whole cap of directions is missing (view culling)
        u = partial[i] / radii[i][:, None]
        m = -u.mean(axis=0)
        m /= np.linalg.norm(m)  # estimated centre of the missing cap
        assert float((u @ m).max()) < 0.6, "no direction gap — the view culling did not happen"

    # occupancy labels are the mesh's TRUE inside/outside: any query inside the smallest possible
    # scaled sphere must be labeled occupied, any query outside the largest must be labeled empty
    q_norm = np.linalg.norm(query, axis=2)
    inner, outer = q_norm < 0.45, q_norm > 1.10
    assert inner.any() and outer.any()
    assert occ[inner].min() == 1.0
    assert occ[outer].max() == 0.0
    assert set(np.unique(occ)) <= {0.0, 1.0}


def test_dataset_is_deterministic_with_a_seed(sphere_dir: Path):
    meshes = load_meshes(sphere_dir)
    a = build_dataset(meshes, samples=2, n_partial=32, n_query=48, seed=9)
    b = build_dataset(meshes, samples=2, n_partial=32, n_query=48, seed=9)
    for x, y in zip(a, b):
        assert np.array_equal(x, y)


def test_non_watertight_meshes_are_skipped(tmp_path: Path):
    d = tmp_path / "open"
    d.mkdir()
    # a single open triangle is not watertight — occupancy has no defined inside
    trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces=[[0, 1, 2]]).export(d / "tri.stl")
    with pytest.raises(ValueError, match="no watertight meshes"):
        load_meshes(d)


def test_checkpoint_save_load_roundtrip(tmp_path: Path, mesh_dir: Path):
    dataset = _tiny_dataset(mesh_dir)
    net, _ = train_completion(dataset, iters=4, batch=4, seed=0)
    ckpt = tmp_path / "roundtrip.safetensors"
    net.save_weights(str(ckpt))

    fresh = CompletionNet()
    fresh.load_weights(str(ckpt))
    mx.eval(fresh.parameters())
    p, q = mx.array(dataset[0][:2]), mx.array(dataset[1][:2])
    assert float(mx.abs(net(p, q) - fresh(p, q)).max()) < 1e-6


def test_resume_starts_from_the_checkpoint_weights(tmp_path: Path, mesh_dir: Path):
    dataset = _tiny_dataset(mesh_dir)
    trained, _ = train_completion(dataset, iters=3, batch=4, seed=0)
    ckpt = tmp_path / "resume.safetensors"
    trained.save_weights(str(ckpt))

    # a zero-iteration resumed run must hold exactly the checkpoint's weights (not a fresh init)
    resumed, losses = train_completion(dataset, iters=0, batch=4, seed=1, resume=ckpt)
    assert losses == []
    p, q = mx.array(dataset[0][:2]), mx.array(dataset[1][:2])
    assert float(mx.abs(trained(p, q) - resumed(p, q)).max()) < 1e-6


def test_env_checkpoint_branch_of_completion_model(tmp_path: Path, monkeypatch):
    # the CAPTURE_COMPLETION_CHECKPOINT escape hatch in app.main._completion_model must LOAD the
    # checkpoint (identical weights), not retrain the synthetic demo completer
    from app import main as app_main

    net = CompletionNet()
    mx.eval(net.parameters())
    ckpt = tmp_path / "tiny.safetensors"
    net.save_weights(str(ckpt))

    monkeypatch.setenv("CAPTURE_COMPLETION_CHECKPOINT", str(ckpt))
    app_main._completion_model.cache_clear()  # the demo net may already be cached by earlier tests
    try:
        loaded = app_main._completion_model()
        assert isinstance(loaded, CompletionNet)
        partial = mx.array(np.random.default_rng(0).normal(size=(1, 32, 3)).astype(np.float32))
        assert float(mx.abs(loaded.encode(partial) - net.encode(partial)).max()) < 1e-6
        assert app_main._completion_model() is loaded  # lru_cache: loaded once, reused
    finally:
        app_main._completion_model.cache_clear()  # don't leak the checkpoint net into other tests


def test_training_on_tiny_real_meshes_reduces_the_loss(mesh_dir: Path):
    dataset = build_dataset(load_meshes(mesh_dir), samples=24, n_partial=96, n_query=128, seed=0)
    _, losses = train_completion(dataset, iters=60, batch=8, seed=0)
    assert len(losses) == 60
    assert float(np.mean(losses[-5:])) < float(np.mean(losses[:5])) - 0.05


def test_cli_trains_and_saves_a_servable_checkpoint(tmp_path: Path, mesh_dir: Path):
    # the real entry point: `python -m app.train_completion <dir> --checkpoint <path>`
    ckpt = tmp_path / "completion.safetensors"
    proc = subprocess.run(
        [
            sys.executable, "-m", "app.train_completion", str(mesh_dir),
            "--checkpoint", str(ckpt), "--iters", "4", "--samples", "4",
            "--batch", "2", "--n-partial", "48", "--n-query", "48", "--seed", "1",
        ],
        cwd=_SERVICE_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, proc.stderr
    assert ckpt.exists()
    CompletionNet().load_weights(str(ckpt))  # the artifact loads exactly like the serving path

    # and --resume continues from it (in-process main covers the same argparse path)
    ckpt2 = tmp_path / "resumed.safetensors"
    main(
        [
            str(mesh_dir), "--checkpoint", str(ckpt2), "--iters", "2", "--samples", "4",
            "--batch", "2", "--n-partial", "48", "--n-query", "48", "--seed", "2",
            "--resume", str(ckpt), "--save-every", "1",
        ]
    )
    assert ckpt2.exists()
    CompletionNet().load_weights(str(ckpt2))
