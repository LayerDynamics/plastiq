"""M1 — Scaled Chamfer Distance surface-fidelity metric (app/fidelity.py).

Ported (Apache-2.0) from StepForge's reward/{step_to_pointcloud,scd_reward}.py — the
deterministic area-weighted barycentric surface sampler + bidirectional Chamfer normalized by
the input's RMS radius. The alignment stage is dropped (the reconstructed B-rep is built from
the input mesh → same frame). See docs/adr/0001-scd-fidelity-metric.md.

Proves: (1) sampling is deterministic + on-surface + area-weighted; (2) SCD ≈ 0 for matching
surfaces, is scale-invariant, and detects a genuine shape difference.
"""

import numpy as np
import trimesh
from OCC.Core.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeSphere
from OCC.Core.gp import gp_Pnt

from app.fidelity import (
    FIDELITY_TOL,
    sample_shape_surface,
    sample_mesh_surface,
    scaled_chamfer,
    surface_fidelity,
)
from app.pipeline import reconstruct

L, W, H = 0.030, 0.020, 0.010  # an asymmetric box so face areas differ


def _box_shape(corner=(0.0, 0.0, 0.0), dx=L, dy=W, dz=H):
    return BRepPrimAPI_MakeBox(gp_Pnt(*corner), dx, dy, dz).Shape()


def _box_mesh(dx=L, dy=W, dz=H):
    """A trimesh box spanning [0,dx]×[0,dy]×[0,dz] — same frame as _box_shape()."""
    m = trimesh.creation.box(extents=[dx, dy, dz])
    m.apply_translation([dx / 2, dy / 2, dz / 2])
    return m


# ── sampler (M1.1) ───────────────────────────────────────────────────────────

def test_sampler_is_deterministic():
    shape = _box_shape()
    a = sample_shape_surface(shape, n_points=1500, seed=7)
    b = sample_shape_surface(shape, n_points=1500, seed=7)
    assert a.shape == (1500, 3)
    assert np.array_equal(a, b)  # same seed → byte-identical
    c = sample_shape_surface(shape, n_points=1500, seed=8)
    assert not np.array_equal(a, c)  # different seed → different sample


def test_sampled_points_lie_on_the_surface():
    pts = sample_shape_surface(_box_shape(), n_points=2000, seed=1)
    # Every point on a [0,L]×[0,W]×[0,H] box has at least one coordinate at a face plane.
    on_x = np.isclose(pts[:, 0], 0, atol=1e-9) | np.isclose(pts[:, 0], L, atol=1e-9)
    on_y = np.isclose(pts[:, 1], 0, atol=1e-9) | np.isclose(pts[:, 1], W, atol=1e-9)
    on_z = np.isclose(pts[:, 2], 0, atol=1e-9) | np.isclose(pts[:, 2], H, atol=1e-9)
    assert np.all(on_x | on_y | on_z)
    # …and inside the box bounds.
    assert pts.min(axis=0).min() > -1e-9
    assert np.all(pts.max(axis=0) <= np.array([L, W, H]) + 1e-9)


def test_sampling_is_area_weighted():
    # A 10:1 slab — the two end caps (z=0,z=H of a 0.10×0.01×0.01 box... here use 0.10×0.01)
    dx, dy, dz = 0.100, 0.010, 0.010
    pts = sample_shape_surface(_box_shape(dx=dx, dy=dy, dz=dz), n_points=4000, seed=3)
    # The two dy×dz end caps (area dy*dz each) are tiny vs the long faces. Their combined
    # area fraction = 2*(dy*dz) / total. total = 2(dx*dy + dy*dz + dx*dz).
    total = 2 * (dx * dy + dy * dz + dx * dz)
    end_frac_true = 2 * (dy * dz) / total
    on_end = np.isclose(pts[:, 0], 0, atol=1e-9) | np.isclose(pts[:, 0], dx, atol=1e-9)
    end_frac = on_end.mean()
    assert end_frac < 3 * end_frac_true  # area-weighted, NOT per-face-uniform (which would be ~1/3)
    assert abs(end_frac - end_frac_true) < 0.05  # tracks the true area fraction


# ── scaled Chamfer (M1.2) ────────────────────────────────────────────────────

def test_scd_below_tolerance_for_identical_surface():
    # Two independent area-weighted samples of the same surface leave a small Chamfer noise
    # floor (~area/n ÷ scale²); the meaningful bar is the fidelity tolerance (FIDELITY_TOL,
    # StepForge's δ_low = 0.01) — a matching surface must score below it.
    shape, mesh = _box_shape(), _box_mesh()
    scd = surface_fidelity(shape, mesh, n_points=3000, seed=5)
    assert scd < FIDELITY_TOL


def test_scd_is_scale_invariant():
    small = surface_fidelity(_box_shape(), _box_mesh(), n_points=3000, seed=5)
    s = 5.0
    big = surface_fidelity(
        _box_shape(dx=L * s, dy=W * s, dz=H * s),
        _box_mesh(dx=L * s, dy=W * s, dz=H * s),
        n_points=3000,
        seed=5,
    )
    assert abs(small - big) < 1e-4  # CD scales by s², scale² scales by s² → ratio constant


def test_scd_detects_a_real_shape_difference():
    # A sphere reconstruction vs a box mesh of similar size must score far worse than box↔box.
    sphere = BRepPrimAPI_MakeSphere(gp_Pnt(L / 2, W / 2, H / 2), 0.015).Shape()
    box_mesh = _box_mesh()
    bad = surface_fidelity(sphere, box_mesh, n_points=3000, seed=5)
    good = surface_fidelity(_box_shape(), box_mesh, n_points=3000, seed=5)
    assert bad > 50 * good
    assert bad > 0.05


def test_scaled_chamfer_pure_arrays():
    rng = np.random.default_rng(0)
    pts = rng.random((500, 3))
    assert scaled_chamfer(pts, pts) == 0.0  # identical clouds → exactly 0
    shifted = pts + np.array([10.0, 0, 0])  # far apart → large
    assert scaled_chamfer(shifted, pts) > 1.0


# ── pipeline integration (M1.3) ──────────────────────────────────────────────

def test_report_carries_surface_deviation_for_analytic_box():
    # An analytic box reconstruction (auto → CSG) reproduces the surface → low deviation.
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    r = reconstruct(glb, "glb", method="auto").report
    assert r.fidelity_tol == FIDELITY_TOL
    assert 0.0 <= r.surface_deviation < FIDELITY_TOL


def test_report_surface_deviation_for_faceted_is_near_zero():
    # Faceted reproduces the mesh triangle-for-triangle → deviation ≈ sampling noise floor.
    glb = trimesh.creation.box(extents=(0.03, 0.02, 0.01)).export(file_type="glb")
    r = reconstruct(glb, "glb", method="faceted").report
    assert r.surface_deviation < FIDELITY_TOL


def test_report_surface_deviation_is_deterministic():
    # NFR-2: same mesh → same score across runs.
    glb = trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48).export(file_type="glb")
    a = reconstruct(glb, "glb", method="auto").report.surface_deviation
    b = reconstruct(glb, "glb", method="auto").report.surface_deviation
    assert a == b


# ── accuracy-ladder decision: SCD is ADVISORY, not a gate (M1.5) ─────────────
# Evidence (docs/adr/0001): a hard SCD ≤ tol gate over-rejected the legitimately-coarse-but-correct
# oblique cut-cylinder (SCD 0.020 > tol 0.01, yet watertight with only 1.5% volume error). So SCD
# ships report-only; the existing volume + RMS + shape-coverage gates remain the acceptance gates.

def test_scd_is_advisory_coarse_correct_fit_is_not_gated_out():
    from tests.test_topology import _oblique_cut_cylinder_mesh

    v, f = _oblique_cut_cylinder_mesh()
    glb = trimesh.Trimesh(v, f, process=False).export(file_type="glb")
    r = reconstruct(glb, "glb", method="auto").report
    # The analytic cut-cylinder is still accepted (NOT downgraded to faceted) even though its
    # surface_deviation exceeds the advisory tolerance — proving SCD does not gate acceptance.
    assert r.method == "cut_cylinder"
    assert r.surface_deviation > r.fidelity_tol  # honestly reported as a looser (coarser) fit


def test_surface_deviation_ranks_a_coarse_fit_above_a_clean_primitive():
    # The advisory value's worth: it distinguishes a near-exact primitive from a coarser fit.
    from tests.test_topology import _oblique_cut_cylinder_mesh

    clean = reconstruct(
        trimesh.creation.cylinder(radius=0.011, height=0.027, sections=48).export(file_type="glb"),
        "glb",
        method="auto",
    ).report
    v, f = _oblique_cut_cylinder_mesh()
    coarse = reconstruct(
        trimesh.Trimesh(v, f, process=False).export(file_type="glb"), "glb", method="auto"
    ).report
    assert clean.surface_deviation < clean.fidelity_tol < coarse.surface_deviation
