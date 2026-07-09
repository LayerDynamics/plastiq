"""Dense MVS orchestration (``app.pipeline.solve_dense``) on the synthetic scene's GROUND-TRUTH poses
(P9 / P10.2). This is the headless-runnable half of the dense contract: the *sparse* SfM cannot
reconstruct the texture-sparse synthetic scene (that needs the real-photo P7 gate — see
``test_api.py``), so here the dense stage is driven directly with the scene's exact poses + sparse
landmarks to prove the wiring end-to-end: per-view two-stage plane-sweep depth → camera→world normal
rotation → multi-view fusion → colouring → an ``x y z nx ny nz r g b`` oriented PLY. Gated on mlx.core.
"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("mlx.core")

from app.pipeline import solve_dense  # noqa: E402
from tests.synthetic import make_synthetic_scene  # noqa: E402


def _parse_ply_header(text: str):
    """Return (vertex_count, property_names) from an ASCII PLY header."""
    lines = text.splitlines()
    assert lines[0] == "ply" and lines[1] == "format ascii 1.0"
    count = None
    props = []
    for ln in lines:
        if ln.startswith("element vertex"):
            count = int(ln.split()[-1])
        elif ln.startswith("property"):
            props.append(ln.split()[-1])
        elif ln == "end_header":
            break
    return count, props


def test_solve_dense_produces_oriented_coloured_cloud():
    """The dense stage on GT poses → a non-empty oriented, coloured cloud whose points lie on the
    synthetic surfaces (fusion's own accuracy is asserted in test_fusion; here we prove the
    orchestration produces a well-formed, non-degenerate, on-surface cloud)."""
    scene = make_synthetic_scene(n_views=8, height=96, width=96, seed=0)

    dense_ply, dense_points, swept = solve_dense(
        scene.images, scene.poses_w2c, scene.points3d, scene.K, max_dense_points=50_000
    )

    # Every view swept without raising, and real points survived multi-view fusion.
    assert swept == scene.images.shape[0]
    assert dense_points > 0, "dense fusion produced no points from GT poses"
    assert dense_ply is not None

    # A well-formed oriented + coloured PLY (the capture hand-off contract, SPEC-13 §6.3).
    count, props = _parse_ply_header(dense_ply)
    assert count == dense_points
    assert props == ["x", "y", "z", "nx", "ny", "nz", "red", "green", "blue"]

    # Parse the body: points are finite, normals are ~unit, colours are bytes.
    rows = [ln.split() for ln in dense_ply.splitlines()[len(props) + 4:] if ln]
    assert len(rows) == dense_points
    arr = np.array([[float(x) for x in r] for r in rows])
    pts, nrm, cols = arr[:, :3], arr[:, 3:6], arr[:, 6:9]
    assert np.isfinite(pts).all()
    assert np.allclose(np.linalg.norm(nrm, axis=1), 1.0, atol=1e-2)  # unit normals
    assert (cols >= 0).all() and (cols <= 255).all()
    # Not all points collapsed to the neutral-grey fallback — real colours were sampled.
    assert not np.all(cols == 200)

    # Sanity: the cloud sits at scene scale (a ±3 ground plane + a box near the origin, cameras at
    # radius ~4.5), not scattered to infinity/NaN, and the bulk hugs the surfaces (median |y| small).
    # Per-point MVS depth noise leaves tails off the surface — fusion's own accuracy bound lives in
    # test_fusion; here we only assert the orchestration yields a well-formed, concentrated cloud.
    assert (np.abs(pts) < 8.0).all()
    assert np.median(np.abs(pts[:, 1])) < 1.5


def test_solve_dense_deterministic():
    """Two runs on identical GT input return an identical dense cloud (no RNG, D-10)."""
    scene = make_synthetic_scene(n_views=6, height=80, width=80, seed=0)
    a = solve_dense(scene.images, scene.poses_w2c, scene.points3d, scene.K, max_dense_points=50_000)
    b = solve_dense(scene.images, scene.poses_w2c, scene.points3d, scene.K, max_dense_points=50_000)
    assert a[1] == b[1] and a[2] == b[2]
    assert a[0] == b[0]  # byte-identical PLY text
