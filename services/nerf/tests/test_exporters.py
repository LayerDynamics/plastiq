"""N9 — exporters: field → mesh (marching cubes) and mesh/point-cloud → GLB.

Analytic fields make the marching-cubes mechanics exact and fast (a unit-sphere SDF; a sphere density
iso-surface), plus one extraction from a real `SDFField` (geometric init ≈ unit sphere). GLB exports
are verified by round-tripping back through trimesh as real geometry.
"""

import io

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")
pytest.importorskip("skimage.measure")
trimesh = pytest.importorskip("trimesh")

from app.exporters.glb_exporter import mesh_to_glb, pointcloud_to_glb  # noqa: E402
from app.exporters.mesh_exporter import (  # noqa: E402
    extract_density_mesh,
    extract_sdf_mesh,
    marching_cubes_field,
)
from app.fields.sdf_field import SDFField  # noqa: E402
from app.utils.config import FieldConfig  # noqa: E402


def _mean_radius(verts: np.ndarray) -> float:
    return float(np.linalg.norm(verts, axis=1).mean())


def test_marching_cubes_analytic_sphere():
    # SDF of a unit sphere: ‖x‖ − 1 → the zero level-set is the unit sphere.
    verts, faces = marching_cubes_field(
        lambda x: mx.sqrt(mx.sum(x * x, axis=-1)) - 1.0, bound=1.6, res=48, level=0.0
    )
    assert verts.shape[0] > 0 and faces.shape[1] == 3
    assert abs(_mean_radius(verts) - 1.0) < 0.05, f"sphere isosurface off: mean radius {_mean_radius(verts):.3f}"


def test_extract_density_mesh_sphere_isosurface():
    # A density field high inside the unit sphere, zero outside; threshold at 10 → the unit sphere.
    class _SphereDensity:
        def __call__(self, x, d):
            r = mx.sqrt(mx.sum(x * x, axis=-1, keepdims=True))
            return mx.where(r < 1.0, 20.0, 0.0), mx.zeros((x.shape[0], 3))

    verts, faces = extract_density_mesh(_SphereDensity(), bound=1.6, res=48, level=10.0)
    assert verts.shape[0] > 0 and faces.shape[0] > 0
    assert abs(_mean_radius(verts) - 1.0) < 0.08, f"density isosurface off: mean radius {_mean_radius(verts):.3f}"


def test_extract_sdf_mesh_from_field():
    # The geometric init makes a real SDFField approximate the unit sphere, so it extracts cleanly.
    field = SDFField(FieldConfig(hidden=32, layers=3), radius=1.0, seed=0)
    mx.eval(field.parameters())
    verts, faces = extract_sdf_mesh(field, bound=1.6, res=40)
    assert verts.shape[0] > 0 and faces.shape[0] > 0
    assert 0.6 < _mean_radius(verts) < 1.5


def test_mesh_to_glb_roundtrips_as_real_mesh():
    verts, faces = marching_cubes_field(
        lambda x: mx.sqrt(mx.sum(x * x, axis=-1)) - 1.0, bound=1.6, res=32, level=0.0
    )
    glb = mesh_to_glb(verts, faces)
    assert isinstance(glb, (bytes, bytearray)) and len(glb) > 0

    loaded = trimesh.load(io.BytesIO(glb), file_type="glb")
    if isinstance(loaded, trimesh.Scene):
        # `to_geometry()` is the current concatenation API (replaced `dump(concatenate=True)`).
        geom = loaded.to_geometry() if hasattr(loaded, "to_geometry") else loaded.dump(concatenate=True)
    else:
        geom = loaded
    assert isinstance(geom, trimesh.Trimesh)
    assert geom.vertices.shape[0] == verts.shape[0]
    assert geom.faces.shape[0] == faces.shape[0]


def test_pointcloud_to_glb_roundtrips():
    rng = np.random.default_rng(0)
    pts = rng.uniform(-1.0, 1.0, size=(256, 3)).astype(np.float32)
    glb = pointcloud_to_glb(pts)
    assert isinstance(glb, (bytes, bytearray)) and len(glb) > 0

    loaded = trimesh.load(io.BytesIO(glb), file_type="glb")
    clouds = [g for g in loaded.geometry.values()] if isinstance(loaded, trimesh.Scene) else [loaded]
    total = sum(getattr(g, "vertices", np.empty((0, 3))).shape[0] for g in clouds)
    assert total == pts.shape[0], f"point count not preserved: {total} != {pts.shape[0]}"
