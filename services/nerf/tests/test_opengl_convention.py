"""FR-9 regression (SPEC-13 §1/FR-9; SPEC-11 §5/FR-3): `parse_transforms` must convert a standard
nerfstudio/COLMAP `transforms.json` — OpenGL/Blender camera axes (−z forward, +y up) — into the
internal +z-forward (OpenCV) convention `rays.py` consumes, by negating the camera y/z axis columns
(`c2w[0:3, 1:3] *= −1`). Without that conversion a real external transforms.json trains garbage: the
center ray points AWAY from the scene (and the image is vertically mirrored). This test builds a
canonical OpenGL pose directly (no dependence on the synthetic fixture) so its red/green tracks the
parser alone: it FAILS on the pre-FR-9 parser (no flip) and PASSES once the flip lands.
"""

import numpy as np
import pytest

mx = pytest.importorskip("mlx.core")

from app.data_processing.dataparser import parse_transforms  # noqa: E402
from app.data_processing.rays import generate_rays  # noqa: E402


def _opengl_transforms(dist: float = 3.0, w: int = 24, h: int = 24, fl: float = 20.0) -> dict:
    """A single OpenGL-convention camera at (0,0,dist) looking down its own −z axis at the origin:
    +x right, +y up, +z back (away from the scene) — identity rotation, translation on +z. This is
    exactly the canonical nerfstudio/Blender c2w a real transforms.json carries. In OpenGL axes this
    camera faces the origin; consumed as-is by the +z-forward ray math it would face away."""
    c2w = np.eye(4, dtype=np.float32)
    c2w[2, 3] = dist  # camera position (0, 0, dist)
    return {
        "w": w, "h": h, "fl_x": fl, "fl_y": fl, "cx": (w - 1) / 2.0, "cy": (h - 1) / 2.0,
        "frames": [{"file_path": "view_0.png", "transform_matrix": c2w.tolist()}],
    }


def test_opengl_c2w_center_ray_aims_at_scene():
    transforms = _opengl_transforms(dist=3.0, w=24, h=24, fl=20.0)
    out = parse_transforms(transforms)
    o, d = generate_rays(out.poses[0], out.fx, out.fy, out.cx, out.cy, out.height, out.width)
    o, d = np.asarray(o), np.asarray(d)
    centre = int((11 * 24) + 11)  # ~principal point (cx = cy = 11.5)
    # The camera position is convention-independent (the translation column is untouched by the flip).
    assert np.allclose(o[centre], [0.0, 0.0, 3.0], atol=1e-4)
    # After the OpenGL→internal flip, the center ray must point from +z toward the origin (−z). On the
    # un-converted (pre-FR-9) parser it points +z, AWAY from the scene, so this dot is ≈ −1.
    toward_scene = np.array([0.0, 0.0, -1.0])
    assert np.dot(d[centre], toward_scene) > 0.99, f"center ray points away from scene: {d[centre]}"


def test_opengl_round_trips_back_to_internal():
    """The flip is its own inverse (it is exactly the photogrammetry emitter's OpenCV→OpenGL flip), so
    parsing a pose that was itself produced by flipping an internal pose recovers that internal pose."""
    internal = np.eye(4, dtype=np.float32)
    internal[:3, :3] = np.diag([1.0, -1.0, -1.0]).astype(np.float32)  # a valid +z-forward (OpenCV) R
    internal[:3, 3] = (0.4, -0.2, 2.5)
    opengl = internal.copy()
    opengl[0:3, 1:3] *= -1.0  # internal → OpenGL (what the emitter writes)
    transforms = {
        "w": 8, "h": 8, "fl_x": 8.0, "fl_y": 8.0, "cx": 3.5, "cy": 3.5,
        "frames": [{"file_path": "v.png", "transform_matrix": opengl.tolist()}],
    }
    out = parse_transforms(transforms)
    assert np.allclose(out.poses[0], internal, atol=1e-6)
