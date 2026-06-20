"""R6.4b — deterministic cone fit + analytic cone solid."""

from math import atan, pi

import numpy as np
import trimesh

from app.curved_faces import cone_solid
from app.detect import reconstruct_cone
from app.primitives import fit_cone

R_TRUE, H_TRUE = 0.01, 0.025


def _cone_region(sections: int = 48):
    # trimesh cone: base radius R_TRUE at z=0, apex at z=H_TRUE.
    m = trimesh.creation.cone(radius=R_TRUE, height=H_TRUE, sections=sections)
    axis = np.array([0, 0, 1.0])
    base = np.abs(m.face_normals @ axis) > 0.95  # base cap normal ≈ -axis
    side = ~base
    verts = m.vertices[np.unique(m.faces[side])]
    return verts, m.face_normals[side], m


def test_fit_recovers_cone_parameters():
    verts, fn, _ = _cone_region()
    fit = fit_cone(verts, fn)
    assert abs(fit.base_radius - R_TRUE) < 5e-4
    assert abs(fit.height - H_TRUE) < 5e-4
    assert abs(fit.half_angle - atan(R_TRUE / H_TRUE)) < np.radians(2)
    assert abs(abs(float(fit.axis @ np.array([0, 0, 1.0]))) - 1.0) < 1e-2
    assert fit.rms < 1e-3


def test_cone_solid_is_watertight():
    verts, fn, _ = _cone_region()
    res = cone_solid(fit_cone(verts, fn))
    assert res.is_solid and res.is_valid
    assert res.n_faces == 2  # lateral + base
    assert abs(res.volume - 1 / 3 * pi * R_TRUE**2 * H_TRUE) < 5e-8


def test_end_to_end_reconstruct_cone_mesh():
    m = trimesh.creation.cone(radius=R_TRUE, height=H_TRUE, sections=64)
    res = reconstruct_cone(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
    assert res.is_solid
    assert abs(res.volume - 1 / 3 * pi * R_TRUE**2 * H_TRUE) < 5e-7
