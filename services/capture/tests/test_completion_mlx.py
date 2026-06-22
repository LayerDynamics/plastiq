"""M8 — MLX shape completion (app/completion_mlx.py): a conditional occupancy network (PointNet
encoder + occupancy decoder) that completes a PARTIAL point cloud into a full watertight mesh.
Real MLX training on Apple Silicon (the M4 Max). See docs/adr/0008.

The synthetic task: partial (hemisphere-masked) sphere scans → the full ball. The completed mesh must
cover the MISSING hemisphere the partial input never saw — i.e. genuine completion, not echoing input.
"""

import numpy as np
import pytest

pytest.importorskip("mlx.core")
pytest.importorskip("skimage")

from app.completion_mlx import complete, fit_completion  # noqa: E402


def _top_hemisphere(r: float = 0.8, n: int = 256, seed: int = 3) -> np.ndarray:
    """A partial scan: surface points on the TOP hemisphere only (z>0) — the bottom is missing."""
    rng = np.random.default_rng(seed)
    pts = []
    while len(pts) < n:
        x = rng.normal(size=3)
        x /= np.linalg.norm(x)
        if x[2] > 0.05:
            pts.append(x * r)
    return np.asarray(pts, dtype=np.float32)


def test_completion_fills_the_missing_hemisphere():
    net = fit_completion(iters=500, seed=0)
    partial = _top_hemisphere(r=0.8)
    assert partial[:, 2].min() > 0  # the input genuinely lacks the bottom
    verts, faces = complete(net, partial, bound=1.2, res=48)
    assert len(faces) > 100
    # the completion must cover the bottom hemisphere the partial never saw
    assert verts[:, 2].min() < -0.4
    radii = np.linalg.norm(verts - verts.mean(axis=0), axis=1)
    assert 0.5 < float(radii.mean()) < 1.1  # roughly the r=0.8 ball it should infer


def test_completion_is_deterministic_with_a_seed():
    a = fit_completion(iters=40, seed=5)
    partial = _top_hemisphere()
    import mlx.core as mx

    za = a.encode(mx.array(partial[None]))
    b = fit_completion(iters=40, seed=5)
    zb = b.encode(mx.array(partial[None]))
    assert float(mx.abs(za - zb).max()) < 1e-4


def test_complete_partial_exports_a_glb():
    from app.pipeline import complete_partial

    net = fit_completion(iters=300, seed=0)
    res = complete_partial(net, _top_hemisphere(r=0.8), grid_res=40)
    glb = res.to_glb()
    assert res.faces > 0
    assert len(glb) > 0
