"""N8 — NeuS/VolSDF surface model (MLX), three real checks:

  N8.1  SDFField: forward shapes; geometric init gives the right inside/outside sign; `sdf()` yields a
        usable input-gradient (what the eikonal term pushes toward unit norm).
  N8.2  VolSDF transform: signed distance → density is non-negative, peaks at the surface (α/2 = 1/2β),
        and is monotone inside→surface→outside.
  N8.3  REAL training on the M4 Max: train VolSDF on synthetic sphere views, assert the held-out view's
        PSNR improves (appearance is genuinely learned through the SDF→density→volume-render path — not
        a stub), and the eikonal-regularized field still marching-cubes into a clean, unit-scaled mesh.

Honest scope (NFR-2/NFR-3): the IGR geometric init seeds a coarse unit sphere — that is load-bearing
by design, exactly as VolSDF/IGR methods rely on it. What N8.3 proves trains from scratch is the
view-dependent appearance (random ~0.5 grey at init → the normal-shaded sphere), rendered through the
VolSDF density transform; the mesh check confirms training + eikonal preserve a extractable surface.
"""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")
measure = pytest.importorskip("skimage.measure")

from app.data_processing.rays import generate_rays  # noqa: E402
from app.engine.trainer import Trainer  # noqa: E402
from app.fields.sdf_field import SDFField  # noqa: E402
from app.models.neus import VolSDFModel  # noqa: E402
from app.utils.config import FieldConfig, NerfConfig, SamplerConfig  # noqa: E402
from app.utils.seeding import make_key  # noqa: E402
from tests.synthetic import make_synthetic_dataset  # noqa: E402


def _rays_for_views(views, imgs, poses, intr):
    o_, d_, t_ = [], [], []
    for v in views:
        o, d = generate_rays(poses[v], intr["fx"], intr["fy"], intr["cx"], intr["cy"], intr["height"], intr["width"])
        o_.append(o)
        d_.append(d)
        t_.append(mx.array(imgs[v].reshape(-1, 3).astype(np.float32)))
    return mx.concatenate(o_), mx.concatenate(d_), mx.concatenate(t_)


def _psnr(pred, gt) -> float:
    mse = float(np.mean((np.asarray(pred) - np.asarray(gt)) ** 2))
    return -10.0 * np.log10(max(mse, 1e-10))


def _extract_mesh(field, *, bound=1.6, res=32):
    """Compact marching-cubes of the SDF zero level-set (the N9 exporter productionizes this)."""
    lin = np.linspace(-bound, bound, res, dtype=np.float32)
    gx, gy, gz = np.meshgrid(lin, lin, lin, indexing="ij")
    grid = np.stack([gx, gy, gz], axis=-1).reshape(-1, 3)
    vals = [np.asarray(field.sdf(mx.array(grid[i : i + 65536]))).reshape(-1) for i in range(0, len(grid), 65536)]
    vol = np.concatenate(vals).reshape(res, res, res)
    verts, faces, _, _ = measure.marching_cubes(vol, level=0.0)
    verts = verts / (res - 1) * (2.0 * bound) - bound  # index space → world units
    return verts.astype(np.float32), faces


def test_sdf_field_forward_and_gradient():
    field = SDFField(FieldConfig(hidden=64, layers=4), radius=1.0, seed=0)
    mx.eval(field.parameters())
    x = mx.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.5, 0.0, 0.0]], dtype=mx.float32)
    dirs = mx.zeros((3, 3))
    sdf, rgb = field(x, dirs)
    assert sdf.shape == (3, 1)
    assert rgb.shape == (3, 3)
    assert np.all((np.asarray(rgb) >= 0.0) & (np.asarray(rgb) <= 1.0))  # sigmoid RGB

    s = np.asarray(sdf).reshape(-1)
    assert s[0] < 0.0 < s[2], f"geometric init sign wrong: origin={s[0]:.3f} (want <0), far={s[2]:.3f} (want >0)"

    # sdf() must give a non-zero, finite per-point input-gradient for the eikonal term to act on.
    pts = mx.array([[1.0, 0.0, 0.0], [0.0, 1.4, 0.0], [0.0, 0.0, 1.8]], dtype=mx.float32)
    g = mx.grad(lambda p: field.sdf(p).sum())(pts)
    assert g.shape == (3, 3)
    gn = np.linalg.norm(np.asarray(g), axis=1)
    assert np.all(np.isfinite(gn)) and np.all(gn > 0.2), f"degenerate sdf gradient: {gn}"


def test_volsdf_density_transform():
    model = VolSDFModel(NerfConfig(field=FieldConfig(hidden=32, layers=3)), laplace_beta=0.1, seed=0)
    sdf = mx.array([[-0.5], [0.0], [0.5]])  # inside, on-surface, outside
    d = np.asarray(model.sdf_to_density(sdf)).reshape(-1)
    assert np.all(d >= 0.0)
    assert abs(d[1] - 1.0 / (2.0 * 0.1)) < 1e-4, f"surface density should be 1/2β=5.0, got {d[1]:.4f}"
    assert d[0] > d[1] > d[2], f"density must fall inside→surface→outside: {d}"


def test_volsdf_density_finite_for_large_sdf():
    """Regression: at a sharp β, large |sdf| must not produce inf/NaN. `mx.where` evaluates BOTH
    branches, so an unclamped `exp(s/β)` overflowed on the unselected branch and 0·inf poisoned the
    gradient with NaN — which diverged training. The clamped transform stays finite in value AND
    gradient across a wide range of signed distances."""
    model = VolSDFModel(NerfConfig(field=FieldConfig(hidden=32, layers=3)), laplace_beta=0.1, seed=0)
    sdf = mx.array([[-5.0], [-1.0], [0.0], [1.0], [5.0]])
    dens = model.sdf_to_density(sdf)
    assert np.all(np.isfinite(np.asarray(dens))), f"density not finite: {np.asarray(dens).reshape(-1)}"
    g = mx.grad(lambda s: model.sdf_to_density(s).sum())(sdf)
    assert np.all(np.isfinite(np.asarray(g))), f"density gradient not finite: {np.asarray(g).reshape(-1)}"


def test_volsdf_training_improves_psnr_and_extracts_mesh():
    imgs, poses, intr, _ = make_synthetic_dataset(n_views=6, h=20, w=20)
    train_o, train_d, train_t = _rays_for_views([0, 1, 2, 3, 4], imgs, poses, intr)
    ho_o, ho_d, ho_t = _rays_for_views([5], imgs, poses, intr)  # held-out novel view

    cfg = NerfConfig(
        field=FieldConfig(hidden=64, layers=4),
        sampler=SamplerConfig(n_samples=48, near=2.0, far=4.2),
    )
    model = VolSDFModel(cfg, laplace_beta=0.2, lam_eikonal=0.1, seed=0)
    before = _psnr(model.render_rays(ho_o, ho_d, key=make_key(99)), ho_t)

    Trainer(model, lr=5e-3, seed=0).train(train_o, train_d, train_t, iters=400, rays_per_batch=512)

    after = _psnr(model.render_rays(ho_o, ho_d, key=make_key(99)), ho_t)
    assert after > before + 1.0, f"VolSDF appearance did not learn: {before:.2f} → {after:.2f} dB"

    verts, faces = _extract_mesh(model.field, res=32)
    assert verts.shape[0] > 0 and faces.shape[0] > 0, "trained field produced an empty mesh"
    mean_r = float(np.linalg.norm(verts, axis=1).mean())
    assert 0.6 < mean_r < 1.5, f"extracted surface is not unit-scaled: mean radius {mean_r:.3f}"
