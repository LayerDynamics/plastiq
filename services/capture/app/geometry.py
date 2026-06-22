"""Camera + depth geometry for the capture path (M6), in MLX (Apple Silicon).

Ported (Apache-2.0) from kornia's `depth_to_3d` / `depth_to_normals` — pinhole unprojection and
gradient-cross-product normal estimation — reimplemented in **MLX** (`mlx.core`), consistent with the
rest of the capture service's models (the M7 SDF + M8 completion). Turns a depth scan into a 3D point
cloud + normals that feed the mesh→B-rep reconstruction. Deterministic. See docs/adr/0006.

Scope (per ADR 0006): the depth/point-cloud math only. SfM pose solvers (Nister 5-point) and fisheye
distortion (Kannala-Brandt) are deliberately NOT built — poses come from COLMAP / the learned field.
"""

from __future__ import annotations

from dataclasses import dataclass

import mlx.core as mx


@dataclass(frozen=True)
class PinholeCamera:
    """Pinhole intrinsics. The camera sits at the origin looking down +z; a pixel `(u, v)` at depth
    `d` back-projects to `((u−cx)·d/fx, (v−cy)·d/fy, d)`."""

    fx: float
    fy: float
    cx: float
    cy: float

    @property
    def K(self) -> mx.array:
        """The 3×3 intrinsic matrix."""
        return mx.array([[self.fx, 0.0, self.cx], [0.0, self.fy, self.cy], [0.0, 0.0, 1.0]])

    def project(self, point) -> tuple[float, float]:
        """Project a camera-frame 3D point to a pixel `(u, v)`."""
        x, y, z = (float(point[0]), float(point[1]), float(point[2]))
        return (self.fx * x / z + self.cx, self.fy * y / z + self.cy)

    def unproject(self, u: float, v: float, depth: float) -> mx.array:
        """Back-project a pixel `(u, v)` at `depth` to a camera-frame 3D point."""
        return mx.array([(u - self.cx) * depth / self.fx, (v - self.cy) * depth / self.fy, depth])


def unproject_depth(depth, cam: PinholeCamera) -> mx.array:
    """Unproject an `(H, W)` depth map into an `(H, W, 3)` grid of camera-frame points (vectorized, MLX)."""
    d = (depth if isinstance(depth, mx.array) else mx.array(depth)).astype(mx.float32)
    h, w = d.shape
    uu, vv = mx.meshgrid(mx.arange(w).astype(mx.float32), mx.arange(h).astype(mx.float32))
    x = (uu - cam.cx) * d / cam.fx
    y = (vv - cam.cy) * d / cam.fy
    return mx.stack([x, y, d], axis=-1)


def _cross(a: mx.array, b: mx.array) -> mx.array:
    """Per-row 3D cross product (MLX has no `cross`)."""
    ax, ay, az = a[..., 0], a[..., 1], a[..., 2]
    bx, by, bz = b[..., 0], b[..., 1], b[..., 2]
    return mx.stack([ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx], axis=-1)


def _grad0(a: mx.array) -> mx.array:
    """∂/∂(axis 0), `np.gradient`-equivalent: one-sided at the edges, central in the interior."""
    return mx.concatenate([a[1:2] - a[:1], (a[2:] - a[:-2]) / 2.0, a[-1:] - a[-2:-1]], axis=0)


def _grad1(a: mx.array) -> mx.array:
    """∂/∂(axis 1), `np.gradient`-equivalent."""
    return mx.concatenate([a[:, 1:2] - a[:, :1], (a[:, 2:] - a[:, :-2]) / 2.0, a[:, -1:] - a[:, -2:-1]], axis=1)


def depth_to_normals(depth, cam: PinholeCamera) -> mx.array:
    """Per-pixel unit surface normals from a depth map: cross product of the unprojected point grid's
    spatial gradients (`∂P/∂u × ∂P/∂v`), oriented toward the camera (−z). `(H, W, 3)`. MLX, deterministic."""
    pts = unproject_depth(depth, cam)
    d_pdv = _grad0(pts)  # along rows (v)
    d_pdu = _grad1(pts)  # along columns (u)
    n = _cross(d_pdu, d_pdv)
    norm = mx.sqrt(mx.sum(n * n, axis=-1, keepdims=True))
    norm = mx.where(norm < 1e-12, mx.array(1.0), norm)
    n = n / norm
    # Orient toward the camera: a surface at z>0 viewed from the origin has a normal with z<0.
    flip = n[..., 2:3] > 0
    return mx.where(flip, -n, n)
