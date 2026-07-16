"""N8 — NeuS/VolSDF surface model (MLX), three real checks:

  N8.1  SDFField: forward shapes; geometric init gives the right inside/outside sign; `sdf()` yields a
        usable input-gradient (what the eikonal term pushes toward unit norm).
  N8.2  VolSDF transform: signed distance → density is non-negative, peaks at the surface (α/2 = 1/2β),
        and is monotone inside→surface→outside.
  N8.3  REAL training on the M4 Max: train VolSDF on synthetic sphere views, assert the held-out view's
        PSNR improves (appearance is genuinely learned through the SDF→density→volume-render path — not
        a stub), and the marching-cubed surface gets geometrically CLOSER to the ground-truth unit
        sphere than the mesh extracted from the freshly-initialized field.

Honest scope (NFR-2/NFR-3): the IGR geometric init seeds a coarse unit sphere — that is load-bearing
by design, exactly as VolSDF/IGR methods rely on it. What N8.3 proves trains from scratch is the
view-dependent appearance (random ~0.5 grey at init → the normal-shaded sphere), rendered through the
VolSDF density transform. Because the init already extracts a rough sphere (test_exporters asserts the
same 0.6<r̄<1.5 unit-scale bound on the UNTRAINED field), that bound alone cannot prove geometric
learning — so the mesh check also requires the vertices' mean |r−1| error against the ground-truth
unit sphere to at least halve versus an extraction from the untrained init (measured: ≈0.21 → ≈0.05
at seed 0; the halving holds across seeds with wide margin).
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
    # Baseline geometry from the UNTRAINED (IGR geometric init) field — the bar training must beat.
    init_verts, _init_faces = _extract_mesh(model.field, res=32)
    init_err = float(np.abs(np.linalg.norm(init_verts, axis=1) - 1.0).mean())

    Trainer(model, lr=5e-3, seed=0).train(train_o, train_d, train_t, iters=400, rays_per_batch=512)

    after = _psnr(model.render_rays(ho_o, ho_d, key=make_key(99)), ho_t)
    assert after > before + 1.0, f"VolSDF appearance did not learn: {before:.2f} → {after:.2f} dB"

    verts, faces = _extract_mesh(model.field, res=32)
    assert verts.shape[0] > 0 and faces.shape[0] > 0, "trained field produced an empty mesh"
    mean_r = float(np.linalg.norm(verts, axis=1).mean())
    assert 0.6 < mean_r < 1.5, f"extracted surface is not unit-scaled: mean radius {mean_r:.3f}"
    # Geometry-level training proof: the untrained init already satisfies the loose unit-scale bound
    # above (test_exporters asserts the identical bound at init), so additionally require the surface's
    # mean |r−1| error vs the ground-truth unit sphere to at least halve relative to the init mesh
    # (measured ≈0.21 → ≈0.05 at seed 0 — a decisive margin, not noise).
    err = float(np.abs(np.linalg.norm(verts, axis=1) - 1.0).mean())
    assert err < 0.5 * init_err, (
        f"training did not improve the extracted geometry: mean |r-1| {init_err:.4f} (init) → {err:.4f} (trained)"
    )


def test_eikonal_term_contributes_to_render_loss():
    # Regression: render_loss must actually include the eikonal penalty. With an identical field + key,
    # the photometric term is bit-identical, so a larger lam_eikonal can only raise the loss via the
    # (positive) eikonal term — if it were dropped/detached, the two losses would be equal.
    imgs, poses, intr, _ = make_synthetic_dataset(n_views=3, h=12, w=12)
    o, d, t = _rays_for_views([0], imgs, poses, intr)
    cfg = NerfConfig(field=FieldConfig(hidden=32, layers=3), sampler=SamplerConfig(n_samples=24, near=2.0, far=4.5))
    l0 = float(VolSDFModel(cfg, laplace_beta=0.2, lam_eikonal=0.0, seed=0).render_loss(o, d, t, make_key(0)))
    l1 = float(VolSDFModel(cfg, laplace_beta=0.2, lam_eikonal=10.0, seed=0).render_loss(o, d, t, make_key(0)))
    assert l1 > l0 + 1e-4, f"eikonal term did not affect the loss: lam0={l0:.5f} lam10={l1:.5f}"


# --- N8.4: the production mechanisms that fix the collapse/divergence (opt-in; ComparativeDeepDive §4.5) ---

def test_learnable_beta_trains_and_stays_above_floor():
    """`learnable_beta` makes the VolSDF density sharpness a trained parameter (the reference VolSDF/
    sdfstudio annealing). The fixed β can never sharpen — which is why the surface collapsed. β must
    actually change under training and stay strictly positive above its floor."""
    imgs, poses, intr, _ = make_synthetic_dataset(n_views=5, h=16, w=16)
    o, d, t = _rays_for_views([0, 1, 2, 3], imgs, poses, intr)
    cfg = NerfConfig(field=FieldConfig(hidden=32, layers=3), sampler=SamplerConfig(n_samples=32, near=2.0, far=4.2))
    model = VolSDFModel(cfg, laplace_beta=0.3, learnable_beta=True, beta_min=5e-3, seed=0)
    b0 = float(np.asarray(model._beta()))
    Trainer(model, lr=5e-3, seed=0).train(o, d, t, iters=60, rays_per_batch=512,
                                          grad_clip=1.0, warmup_frac=0.1, lr_final_frac=0.1)
    b1 = float(np.asarray(model._beta()))
    assert b1 != b0, f"β did not train (stayed {b0})"
    assert b1 >= 5e-3, f"β fell below its floor: {b1}"


def test_background_composites_empty_rays_toward_bg_colour():
    """With a background colour, low-accumulation rays composite toward it (pixel = Σw·c + (1−Σw)·bg).
    A ray pointing away from the origin sphere renders ~black with no background and ~bright with a
    white background — the fix for the white-bg synthetic mismatch that collapsed PSNR."""
    s = SamplerConfig(n_samples=32, near=0.1, far=2.0)
    fld = FieldConfig(hidden=32, layers=3)
    o = mx.array([[6.0, 0.0, 0.0]])  # far outside the unit sphere, pointing further away → accumulation ≈ 0
    d = mx.array([[1.0, 0.0, 0.0]])
    rgb_bg = np.asarray(VolSDFModel(NerfConfig(field=fld, sampler=s, background=(1.0, 1.0, 1.0)), seed=0)
                        .render_rays(o, d, key=make_key(1)))[0]
    rgb_none = np.asarray(VolSDFModel(NerfConfig(field=fld, sampler=s), seed=0)
                          .render_rays(o, d, key=make_key(1)))[0]
    assert rgb_bg.mean() > rgb_none.mean() + 0.3, f"background not composited: bg={rgb_bg} none={rgb_none}"


def test_silhouette_mask_loss_fires_on_4channel_target():
    """A 4-channel (RGBA) target adds `mask_weight·(accumulation − alpha)²`. An all-ZEROS alpha (demand
    empty everywhere) disagrees with the object the rays actually hit (accumulation > 0), so the RGBA
    loss is strictly larger than the RGB-only loss — proving the silhouette term is active (it pins
    opacity to the object mask, preventing the empty-surface collapse on masked scenes)."""
    imgs, poses, intr, _ = make_synthetic_dataset(n_views=4, h=16, w=16)
    o, d, t = _rays_for_views([0], imgs, poses, intr)
    model = VolSDFModel(NerfConfig(field=FieldConfig(hidden=32, layers=3),
                                   sampler=SamplerConfig(n_samples=32, near=2.0, far=4.2)), seed=0)
    rgba = mx.concatenate([t, mx.zeros((t.shape[0], 1), dtype=mx.float32)], axis=1)  # alpha=0 disagrees with the object
    l_rgb = float(model.render_loss(o, d, t, make_key(1)))
    l_rgba = float(model.render_loss(o, d, rgba, make_key(1)))
    assert l_rgba > l_rgb, f"silhouette mask term did not add to the loss: rgb={l_rgb:.5f} rgba={l_rgba:.5f}"
