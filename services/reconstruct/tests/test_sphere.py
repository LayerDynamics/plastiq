"""R6.4b — deterministic sphere fit + analytic sphere solid."""

from math import pi

import numpy as np
import trimesh

from app.curved_faces import sphere_solid
from app.detect import reconstruct_sphere
from app.primitives import fit_sphere

R_TRUE = 0.013
CENTER = np.array([0.02, -0.01, 0.005])


def _sphere_mesh(subdiv: int = 3) -> trimesh.Trimesh:
    return trimesh.creation.icosphere(subdivisions=subdiv, radius=R_TRUE).apply_translation(CENTER)


def test_fit_recovers_center_and_radius():
    m = _sphere_mesh()
    fit = fit_sphere(np.asarray(m.vertices))
    assert abs(fit.radius - R_TRUE) < 2e-4
    assert np.allclose(fit.center, CENTER, atol=2e-4)
    assert fit.rms < 1e-4


def test_fit_is_deterministic():
    v = np.asarray(_sphere_mesh().vertices)
    a, b = fit_sphere(v), fit_sphere(v)
    assert a.radius == b.radius and np.array_equal(a.center, b.center)


def test_sphere_solid_is_watertight_one_face():
    fit = fit_sphere(np.asarray(_sphere_mesh().vertices))
    res = sphere_solid(fit)
    assert res.is_solid and res.is_valid
    assert res.n_faces == 1  # one analytic spherical face, not hundreds of triangles
    assert abs(res.volume - 4 / 3 * pi * R_TRUE**3) < 1e-8


def test_end_to_end_reconstruct_sphere_mesh():
    m = _sphere_mesh()
    res = reconstruct_sphere(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res.is_solid
    assert abs(res.volume - 4 / 3 * pi * R_TRUE**3) < 1e-7
