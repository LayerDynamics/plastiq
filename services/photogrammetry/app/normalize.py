"""Scene normalization — the D-5 producer contract (SPEC-13 §5.4-5, FR-8; plan P6.1).

The nerf consumer bakes in a **fixed** scene radius (``services/nerf/app/engine/pipeline.py:28``
``_SCENE_RADIUS = 1.5``, marching-cubes over ``[-1.6, 1.6]^3`` at ``:119`` /
``exporters/mesh_exporter.py:43``). Unlike nerfstudio, which normalizes loader-side, we bake the
similarity into the emitted poses/points so an un-normalized scene never clips. This module computes
that similarity and applies it to both the solved cameras and the sparse points.

The similarity ``T`` is a world→world map ``X' = s R_n X + tvec`` (uniform scale ``s``, rotation
``R_n``, translation ``tvec``) chosen so that, in the normalized frame:
  * the **mean camera-up** direction maps to +z (nerfstudio's ``"up"`` orientation) — camera up is
    the OpenCV ``-R[1]`` (the negative of the +y/down camera row), averaged over views;
  * the **sparse-point median** maps to the origin (center);
  * the **90th-percentile point radius** about that new center maps to 1.0 (scale — keeps the scene
    comfortably inside nerf's 1.5 radius).

``applied_transform`` records ``T`` in the **forward** direction — ``solver world → normalized
world`` — as a 3×4 ``[s R_n | tvec]`` (SPEC-13 §6.2). Recover solver-frame coordinates by applying
its inverse. Poses transform so that projecting a transformed point through the transformed pose
yields the *same* pixel as before (reprojection invariant); see :func:`normalize_scene`.

MLX-free by construction (numpy only): this module is on the CI import seam (NFR-4) with
``emit``/``exif``/``jobs``. It never imports ``mlx`` or ``cv2`` (D-1). Deterministic — no RNG.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

__all__ = ["NormalizeResult", "normalize_scene"]

_UP_TARGET = np.array([0.0, 0.0, 1.0])  # nerfstudio "up" orientation aligns mean camera-up to +z.


@dataclass
class NormalizeResult:
    """Result of :func:`normalize_scene`.

    Attributes:
        poses_w2c: ``(N, 3, 4)`` transformed world-to-camera ``[R | t]`` poses (OpenCV +z-forward),
            expressed in the normalized world frame.
        points3d: ``(M, 3)`` sparse points in the normalized world frame.
        applied_transform: ``(3, 4)`` forward similarity ``[s R_n | tvec]`` mapping **original
            (solver) world → normalized world**: ``X_norm = applied_transform[:, :3] @ X_solver +
            applied_transform[:, 3]``. Its inverse (extend to 4×4 with a ``[0, 0, 0, 1]`` row and
            invert) recovers solver-frame coordinates.
        scale: the uniform scale factor ``s`` of the similarity (also ``report.normalization.scale``,
            FR-8). Equals the norm of any row of ``applied_transform[:, :3]``.
    """

    poses_w2c: np.ndarray
    points3d: np.ndarray
    applied_transform: np.ndarray
    scale: float


def _rotation_aligning(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Proper rotation ``R`` (det +1) with ``R @ src == dst`` for unit vectors ``src``, ``dst``.

    Rodrigues' rotation about ``src × dst``; the antiparallel case rotates 180° about an arbitrary
    axis perpendicular to ``src`` (deterministic pick)."""
    src = src / np.linalg.norm(src)
    dst = dst / np.linalg.norm(dst)
    v = np.cross(src, dst)
    c = float(src @ dst)
    if c > 1.0 - 1e-12:  # already aligned
        return np.eye(3)
    if c < -1.0 + 1e-12:  # antiparallel — 180° about any perpendicular axis
        axis = np.cross(src, np.array([1.0, 0.0, 0.0]))
        if np.linalg.norm(axis) < 1e-8:
            axis = np.cross(src, np.array([0.0, 1.0, 0.0]))
        axis = axis / np.linalg.norm(axis)
        k = _skew(axis)
        return np.eye(3) + 2.0 * (k @ k)
    k = _skew(v)
    return np.eye(3) + k + (k @ k) * (1.0 / (1.0 + c))


def _skew(v: np.ndarray) -> np.ndarray:
    return np.array(
        [
            [0.0, -v[2], v[1]],
            [v[2], 0.0, -v[0]],
            [-v[1], v[0], 0.0],
        ]
    )


def _mean_camera_up(rots: np.ndarray) -> np.ndarray:
    """Unit mean camera-up in world from w2c rotations ``(N, 3, 3)``.

    A w2c ``[R | t]`` has camera axes as the rows of ``R`` (OpenCV: row 0 right, row 1 down, row 2
    forward). Camera up is the negative of the +y/down row (``-R[1]``) — the nerfstudio ``"up"``
    analog. Rows of a rotation are unit vectors, so we average then renormalize."""
    ups = -rots[:, 1, :]  # (N, 3)
    mean_up = ups.mean(axis=0)
    return mean_up / np.linalg.norm(mean_up)


def normalize_scene(poses_w2c: np.ndarray, points3d: np.ndarray) -> NormalizeResult:
    """Apply the D-5 normalizing similarity to solved poses + sparse points.

    Args:
        poses_w2c: ``(N, 3, 4)`` world-to-camera ``[R | t]`` poses (OpenCV +z-forward solver frame).
        points3d: ``(M, 3)`` sparse points in the solver world frame.

    Returns:
        A :class:`NormalizeResult` with poses + points in the normalized frame, the forward
        ``applied_transform`` (solver world → normalized world) and its ``scale``.

    Math. The world similarity is ``X' = s R_n X + tvec``. For a camera ``[R_c | t_c]`` (world→cam,
    ``X_c = R_c X + t_c``) the transformed pose is ``[R_c R_n^T | s t_c - R_c R_n^T tvec]``. Then the
    transformed camera coordinates equal ``s X_c`` — same ray, so pixels are invariant (the
    projection divides by depth, cancelling ``s``), while ``R_c R_n^T`` stays a proper rotation.
    """
    poses = np.asarray(poses_w2c, dtype=np.float64)
    pts = np.asarray(points3d, dtype=np.float64)
    if poses.ndim != 3 or poses.shape[1:] != (3, 4):
        raise ValueError(f"poses_w2c must have shape (N, 3, 4); got {poses.shape}")
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise ValueError(f"points3d must have shape (M, 3); got {pts.shape}")
    if pts.shape[0] == 0:
        raise ValueError("points3d must contain at least one point to center/scale the scene")

    rots = poses[:, :, :3]  # (N, 3, 3)
    trans = poses[:, :, 3]  # (N, 3)

    # (a) Orientation: rotate the world so mean camera-up → +z.
    r_n = _rotation_aligning(_mean_camera_up(rots), _UP_TARGET)

    # (b) Center: median of the rotated points → origin.  (c) Scale: 90th-pct radius → 1.
    rotated = pts @ r_n.T  # (M, 3)
    median = np.median(rotated, axis=0)
    radii = np.linalg.norm(rotated - median, axis=1)
    r90 = float(np.percentile(radii, 90))
    scale = 1.0 / max(r90, 1e-12)  # guard a degenerate (all-coincident) cloud
    tvec = -scale * median  # so median(X') = scale*median - scale*median = 0

    # Points: X' = s R_n X + tvec == s (R_n X - median).
    new_points = scale * (rotated - median)

    # Poses: [R_c R_n^T | s t_c - R_c R_n^T tvec] — reprojection-invariant (see docstring).
    new_rots = rots @ r_n.T  # (N, 3, 3)
    new_trans = scale * trans - np.einsum("nij,j->ni", new_rots, tvec)  # (N, 3)
    new_poses = np.concatenate([new_rots, new_trans[:, :, None]], axis=2)  # (N, 3, 4)

    applied = np.concatenate([scale * r_n, tvec[:, None]], axis=1)  # (3, 4) forward similarity

    return NormalizeResult(
        poses_w2c=new_poses,
        points3d=new_points,
        applied_transform=applied,
        scale=scale,
    )
