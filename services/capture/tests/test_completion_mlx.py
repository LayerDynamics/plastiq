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


def test_complete_partial_handles_non_unit_scale():
    # Regression: the net is trained on unit-scale spheres over a fixed [-1.2,1.2]³ grid. complete_partial
    # must normalize the input to unit scale (else a large scan falls outside the field → empty/garbage
    # mesh) and rescale the result back. A 10× scan must yield a non-empty mesh at ~10× extent.
    from app.pipeline import complete_partial

    net = fit_completion(iters=300, seed=0)
    res = complete_partial(net, _top_hemisphere(r=0.8) * 10.0, grid_res=40)
    assert res.vertices > 0 and res.faces > 0
    extent = float(np.abs(res.mesh.vertices).max())
    assert extent > 3.0, f"scale was not honored (extent {extent:.2f}; expected ~8 for a 10× r=0.8 ball)"


def test_marching_cubes_field_raises_clear_error_on_no_crossing():
    # A single-signed field has no surface; the shared helper must raise a CLEAR error (not skimage's
    # opaque "Surface level must be within volume data range").
    import mlx.core as mx

    from app.marching import marching_cubes_field

    with pytest.raises(ValueError, match="no 0.0 crossing"):
        marching_cubes_field(lambda x: mx.ones((x.shape[0],)), bound=1.0, res=8)
