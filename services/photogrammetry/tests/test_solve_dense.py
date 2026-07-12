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


def test_solve_dense_min_views_gate_is_honored():
    """The fusion ``min_views`` knob is plumbed through solve_dense (it was hard-coded to 2). A
    stricter multi-view-consistency gate yields no more points than a looser one, and a gate that
    demands more confirmations than there are views deterministically survives nothing — proving the
    parameter actually reaches :func:`app.mvs.fusion.fuse` rather than being silently dropped."""
    scene = make_synthetic_scene(n_views=6, height=96, width=96, seed=0)
    kw = dict(max_dense_points=500_000)  # high cap → counts reflect the gate, not the cap

    _, n2, _ = solve_dense(scene.images, scene.poses_w2c, scene.points3d, scene.K, min_views=2, **kw)
    _, n4, _ = solve_dense(scene.images, scene.poses_w2c, scene.points3d, scene.K, min_views=4, **kw)
    assert n2 > 0
    assert n4 <= n2  # stricter gate keeps a subset — monotonic in min_views

    # More required confirmations than views exist ⇒ nothing can survive (need = min_views-1 OTHER
    # views, but only n_views-1 exist). If this returned points, min_views was being ignored.
    dense_ply, n_impossible, _ = solve_dense(
        scene.images, scene.poses_w2c, scene.points3d, scene.K, min_views=scene.images.shape[0] + 1, **kw
    )
    assert n_impossible == 0 and dense_ply is None


def test_solve_dense_decouples_resolution():
    """Dense MVS runs at a resolution independent of the (GT) poses when K is scaled to match — the
    'register at a robust reduced res, densify at full input res' path. Upsampling the views ×2 and
    scaling K ×2 must still produce a well-formed on-surface cloud (extrinsics are resolution-free)."""
    import mlx.core  # noqa: F401  — gated at module import; kept explicit for the resolution path

    scene = make_synthetic_scene(n_views=6, height=64, width=64, seed=0)
    r = 2
    big = np.repeat(np.repeat(scene.images, r, axis=1), r, axis=2)  # nearest-neighbour ×2 upsample
    K2 = scene.K.copy()
    K2[0, 0] *= r
    K2[1, 1] *= r
    K2[0, 2] = (K2[0, 2] + 0.5) * r - 0.5  # pixel-centre-consistent principal-point scaling
    K2[1, 2] = (K2[1, 2] + 0.5) * r - 0.5

    _, n_pts, swept = solve_dense(big, scene.poses_w2c, scene.points3d, K2, max_dense_points=200_000)
    assert swept == scene.images.shape[0]
    assert n_pts > 0  # the scaled-K dense pass reconstructs at the higher resolution
