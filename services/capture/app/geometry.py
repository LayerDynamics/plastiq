"""Camera + depth geometry for the capture path (M6).

Ported (Apache-2.0) from kornia's `depth_to_3d` / `depth_to_normals` — the pinhole unprojection and
gradient-cross-product normal estimation — reimplemented in pure numpy (no torch). Used by the
capture service (M7) to turn a depth scan into a 3D point cloud + normals that feed the mesh→B-rep
reconstruction. Deterministic. See docs/adr/0006.

Scope (per ADR 0006): this is the depth/point-cloud math only. SfM pose solvers (Nister 5-point) and
fisheye distortion (Kannala-Brandt) are deliberately NOT built — camera poses come from COLMAP / the
learned field in M7, so a hand-rolled 5-point solver would have no consumer.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class PinholeCamera:
    """Pinhole intrinsics. The camera sits at the origin looking down +z; a pixel `(u, v)` at depth
    `d` back-projects to `((u−cx)·d/fx, (v−cy)·d/fy, d)`."""

    fx: float
    fy: float
    cx: float
    cy: float

    @property
    def K(self) -> np.ndarray:
        """The 3×3 intrinsic matrix."""
        return np.array([[self.fx, 0.0, self.cx], [0.0, self.fy, self.cy], [0.0, 0.0, 1.0]], dtype=float)

    def project(self, point: np.ndarray) -> tuple[float, float]:
        """Project a camera-frame 3D point to a pixel `(u, v)`."""
        x, y, z = (float(point[0]), float(point[1]), float(point[2]))
        return (self.fx * x / z + self.cx, self.fy * y / z + self.cy)

    def unproject(self, u: float, v: float, depth: float) -> np.ndarray:
        """Back-project a pixel `(u, v)` at `depth` to a camera-frame 3D point."""
        return np.array([(u - self.cx) * depth / self.fx, (v - self.cy) * depth / self.fy, depth], dtype=float)


def unproject_depth(depth: np.ndarray, cam: PinholeCamera) -> np.ndarray:
    """Unproject an `(H, W)` depth map into an `(H, W, 3)` grid of camera-frame points (vectorized)."""
    depth = np.asarray(depth, dtype=float)
    h, w = depth.shape
    uu, vv = np.meshgrid(np.arange(w), np.arange(h))  # (H, W) each
    x = (uu - cam.cx) * depth / cam.fx
    y = (vv - cam.cy) * depth / cam.fy
    return np.stack([x, y, depth], axis=-1)


def depth_to_normals(depth: np.ndarray, cam: PinholeCamera) -> np.ndarray:
    """Per-pixel unit surface normals from a depth map: cross product of the unprojected point grid's
    spatial gradients (`∂P/∂u × ∂P/∂v`), oriented toward the camera (−z). `(H, W, 3)`. Deterministic."""
    pts = unproject_depth(depth, cam)
    d_pdv = np.gradient(pts, axis=0)  # along rows (v)
    d_pdu = np.gradient(pts, axis=1)  # along columns (u)
    n = np.cross(d_pdu, d_pdv)
    norm = np.linalg.norm(n, axis=-1, keepdims=True)
    norm = np.where(norm < 1e-12, 1.0, norm)
    n = n / norm
    # Orient toward the camera: a surface at z>0 viewed from the origin has a normal with z<0.
    flip = n[..., 2] > 0
    n[flip] = -n[flip]
    return n
