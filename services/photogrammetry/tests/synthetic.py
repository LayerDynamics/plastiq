"""Synthetic-scene ground-truth oracle for the photogrammetry pipeline (P1.1).

A deterministic textured 3D scene (a finite ground plane + an axis-aligned box) rendered from known
camera poses by a vectorized ray caster with a true z-buffer, yielding, per view: an RGB image with
rich procedural texture (so feature detection has real structure), an exact per-pixel depth map, and
a landmark→observations visibility oracle whose entries are *reprojection-consistent by
construction*. Every downstream oracle (features, essential/fundamental, PnP, triangulation, BA, the
mapper, plane-sweep MVS) is validated against this scene, so it is exact and self-consistent — not a
smoke fixture.

Camera convention: OpenCV / **+z forward** (a visible point has positive camera-space depth), the
same convention SPEC-13 calls the internal solver frame. The emitter (P6.3) flips to OpenGL; that is
not this fixture's concern. Poses are stored world-to-camera as ``[R | t]`` (3×4), so a world point
``X`` maps to camera space by ``X_c = R X + t``.

Deterministic: one ``numpy.random.Generator`` per call (procedural texture is a seeded integer hash,
not RNG state), no wall-clock. Pure numpy; the distorted-view path reuses ``app.core.distortion``.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.core.distortion import distort_points, undistort_points

# --- scene geometry (world units, metres) -----------------------------------------------------
_PLANE_Y = 0.0
_PLANE_HALF = 3.0
_BOX_MIN = np.array([-0.7, 0.0, -0.7])
_BOX_MAX = np.array([0.7, 1.4, 0.7])
_TARGET = np.array([0.0, 0.4, 0.0])  # cameras look here
_CAM_RADIUS = 4.5
_CAM_HEIGHT = 2.6
_CAM_ARC = 1.2  # half-angle of the camera arc, radians (±~69°) — overlapping views with baseline

__all__ = ["SyntheticScene", "look_at", "project_points", "make_synthetic_scene"]


@dataclass
class SyntheticScene:
    images: np.ndarray  # (N, H, W, 3) uint8 — the pinhole renders
    K: np.ndarray  # (3, 3) shared intrinsics
    poses_w2c: np.ndarray  # (N, 3, 4) world-to-camera [R | t], OpenCV +z-forward
    depths: np.ndarray  # (N, H, W) camera-space Z per pixel; np.inf where the ray hit nothing
    points3d: np.ndarray  # (M, 3) landmark world coordinates
    points_rgb: np.ndarray  # (M, 3) uint8 landmark colour (mean of its observations)
    visibility: list  # length M; each a list of (view, u, v) — reprojection-consistent observations
    images_distorted: np.ndarray | None  # (N, H, W, 3) uint8 if `distortion` was given, else None
    dist_coeffs: np.ndarray | None  # (4,) Brown-Conrady [k1,k2,p1,p2] if given, else None


def look_at(eye, target, up=(0.0, 1.0, 0.0)) -> np.ndarray:
    """World-to-camera ``[R | t]`` (3×4) for a camera at ``eye`` looking at ``target``.

    OpenCV convention: +z is forward (toward the target), so ``(R (target-eye))[2] > 0``. ``R`` is a
    proper rotation (orthonormal, det +1); its rows are the camera axes expressed in world."""
    eye = np.asarray(eye, dtype=np.float64)
    target = np.asarray(target, dtype=np.float64)
    up = np.asarray(up, dtype=np.float64)
    f = target - eye
    f = f / np.linalg.norm(f)  # +z (forward)
    r = np.cross(up, f)
    if np.linalg.norm(r) < 1e-8:  # up nearly parallel to the view direction
        r = np.cross(np.array([0.0, 0.0, 1.0]), f)
    r = r / np.linalg.norm(r)  # +x (right)
    d = np.cross(f, r)  # +y (down); r × d = f, so [r, d, f] is right-handed
    R = np.stack([r, d, f], axis=0)
    t = -R @ eye
    return np.concatenate([R, t[:, None]], axis=1)


def project_points(points3d, K, pose_w2c, dist=None):
    """Project ``(M, 3)`` world points → ``((M, 2) pixels, (M,) camera-space depth)``.

    With ``dist`` (Brown-Conrady ``[k1,k2,p1,p2[,k3]]``), the normalized coordinates are distorted
    before applying ``K`` — the exact forward model of a lens with those coefficients."""
    pts = np.asarray(points3d, dtype=np.float64)
    K = np.asarray(K, dtype=np.float64)
    pose = np.asarray(pose_w2c, dtype=np.float64)
    R, t = pose[:, :3], pose[:, 3]
    xc = pts @ R.T + t  # (M, 3) camera space
    z = xc[:, 2]
    xn = xc[:, 0] / z
    yn = xc[:, 1] / z
    if dist is not None:
        dn = distort_points(np.stack([xn, yn], axis=1), dist)
        xn, yn = dn[:, 0], dn[:, 1]
    u = K[0, 0] * xn + K[0, 2]
    v = K[1, 1] * yn + K[1, 2]
    return np.stack([u, v], axis=1), z


def _camera_center(pose_w2c: np.ndarray) -> np.ndarray:
    R, t = pose_w2c[:, :3], pose_w2c[:, 3]
    return -R.T @ t  # eye = -Rᵀ t


def _hash01(ix, iy, iz, seed: int) -> np.ndarray:
    """Deterministic integer hash of a 3D lattice cell → float in [0, 1). Vectorized, uint64."""
    ix = ix.astype(np.uint64)
    iy = iy.astype(np.uint64)
    iz = iz.astype(np.uint64)
    with np.errstate(over="ignore"):  # 64-bit wraparound is the hash mixer's intended behaviour
        h = np.uint64(seed) * np.uint64(0x9E3779B97F4A7C15)
        for coord, prime in (
            (ix, 0xFF51AFD7ED558CCD),
            (iy, 0xC4CEB9FE1A85EC53),
            (iz, 0xD6E8FEB86659FD93),
        ):
            h = h ^ (coord * np.uint64(prime))
            h = (h ^ (h >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
            h = h ^ (h >> np.uint64(27))
        h = h ^ (h >> np.uint64(31))
    return (h >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def _value_noise3(p: np.ndarray, seed: int, octaves: int = 4) -> np.ndarray:
    """Multi-octave trilinear value noise sampled at ``(N, 3)`` points → ``(N,)`` in [0, 1]."""
    total = np.zeros(p.shape[0], dtype=np.float64)
    amp_sum = 0.0
    freq, amp = 1.6, 1.0
    for o in range(octaves):
        q = p * freq
        i0 = np.floor(q).astype(np.int64)
        fr = q - i0
        w = fr * fr * (3.0 - 2.0 * fr)  # smoothstep
        acc = np.zeros(p.shape[0], dtype=np.float64)
        for cx in (0, 1):
            for cy in (0, 1):
                for cz in (0, 1):
                    corner = _hash01(i0[:, 0] + cx, i0[:, 1] + cy, i0[:, 2] + cz, seed + o * 101)
                    wx = w[:, 0] if cx else (1.0 - w[:, 0])
                    wy = w[:, 1] if cy else (1.0 - w[:, 1])
                    wz = w[:, 2] if cz else (1.0 - w[:, 2])
                    acc += corner * wx * wy * wz
        total += amp * acc
        amp_sum += amp
        freq *= 2.03
        amp *= 0.5
    return total / amp_sum


def _surface_color(points: np.ndarray, surface_id: np.ndarray, seed: int) -> np.ndarray:
    """Procedural RGB (uint8) for world hit ``points`` given a per-point surface id (0 plane, 1 box).

    Three seed-offset noise channels give chromatic texture; a per-surface tint keeps the plane and
    box distinguishable. High-frequency octaves guarantee corners/blobs for feature detection."""
    n = points.shape[0]
    rgb = np.zeros((n, 3), dtype=np.float64)
    for c in range(3):
        noise = _value_noise3(points, seed + 1000 * (c + 1), octaves=4)
        rgb[:, c] = 45.0 + 190.0 * noise
    tint = np.where(surface_id[:, None] == 1, np.array([25.0, -10.0, -20.0]), np.array([-10.0, 5.0, 25.0]))
    rgb = np.clip(rgb + tint, 0.0, 255.0)
    return rgb


def _intersect(origin: np.ndarray, dirs: np.ndarray):
    """Cast rays ``origin + s·dirs`` (dirs ``(N, 3)``) at the plane + box.

    Returns ``(s, surface_id, hit_point, hit_mask)``: nearest positive hit distance ``s`` (which
    equals camera-space Z because ``dirs`` carries z-component 1), the surface id (0 plane, 1 box),
    the world hit point, and a boolean mask of rays that hit anything."""
    d = np.where(np.abs(dirs) < 1e-12, 1e-12, dirs)  # avoid division by zero on axis-aligned rays

    # Ground plane y = _PLANE_Y, finite extent.
    s_plane = (_PLANE_Y - origin[1]) / d[:, 1]
    hp = origin + s_plane[:, None] * d
    plane_ok = (s_plane > 1e-6) & (np.abs(hp[:, 0]) <= _PLANE_HALF) & (np.abs(hp[:, 2]) <= _PLANE_HALF)
    s_plane = np.where(plane_ok, s_plane, np.inf)

    # Axis-aligned box slab test.
    t0 = (_BOX_MIN - origin) / d
    t1 = (_BOX_MAX - origin) / d
    tmin = np.max(np.minimum(t0, t1), axis=1)
    tmax = np.min(np.maximum(t0, t1), axis=1)
    box_ok = (tmax >= np.maximum(tmin, 0.0)) & (tmin > 1e-6)
    s_box = np.where(box_ok, tmin, np.inf)

    s = np.minimum(s_plane, s_box)
    surface = np.where(s_box < s_plane, 1, 0)
    hit_mask = np.isfinite(s)
    hit_point = origin + np.where(hit_mask, s, 0.0)[:, None] * d
    return s, surface, hit_point, hit_mask


def _render(pose_w2c: np.ndarray, K: np.ndarray, height: int, width: int, seed: int, dist=None):
    """Render one view → (image uint8 (H,W,3), depth (H,W) with inf background).

    ``dist`` set ⇒ a physically distorted view: each output pixel's incoming ray is the ray of the
    *ideal* (undistorted) coordinate, so straight world lines bend exactly as a real lens bends them.
    """
    R = pose_w2c[:, :3]
    origin = _camera_center(pose_w2c)
    uu, vv = np.meshgrid(np.arange(width, dtype=np.float64), np.arange(height, dtype=np.float64))
    u = uu.ravel()
    v = vv.ravel()
    if dist is not None:
        ideal = undistort_points(np.stack([u, v], axis=1), K, dist)  # distorted pixel → ideal pixel
        u_i, v_i = ideal[:, 0], ideal[:, 1]
    else:
        u_i, v_i = u, v
    xn = (u_i - K[0, 2]) / K[0, 0]
    yn = (v_i - K[1, 2]) / K[1, 1]
    d_c = np.stack([xn, yn, np.ones_like(xn)], axis=1)  # camera-space ray dirs (z = 1)
    dirs = d_c @ R  # world dirs = Rᵀ d_c per row  (d_c @ R == (Rᵀ d_cᵀ)ᵀ)

    s, surface, hit_point, hit_mask = _intersect(origin, dirs)
    color = np.zeros((u.shape[0], 3), dtype=np.float64)
    color[hit_mask] = _surface_color(hit_point[hit_mask], surface[hit_mask], seed)
    image = np.clip(np.rint(color), 0, 255).astype(np.uint8).reshape(height, width, 3)
    depth = np.where(hit_mask, s, np.inf).reshape(height, width)
    return image, depth


def _landmarks() -> np.ndarray:
    """A deterministic set of surface landmarks: a plane grid + points on the box's visible faces."""
    pts = []
    g = np.linspace(-2.2, 2.2, 6)
    for x in g:
        for z in g:
            pts.append((x, _PLANE_Y, z))
    face = np.linspace(-0.55, 0.55, 3)
    for a in face:
        for b in face:
            pts.append((a, _BOX_MAX[1], b))  # top
            pts.append((a, _BOX_MAX[1] * 0.5 + 0.35, _BOX_MIN[2]))  # front (-z)
            pts.append((a, _BOX_MAX[1] * 0.5 + 0.35, _BOX_MAX[2]))  # back  (+z)
            pts.append((_BOX_MIN[0], _BOX_MAX[1] * 0.5 + 0.35, b))  # left  (-x)
            pts.append((_BOX_MAX[0], _BOX_MAX[1] * 0.5 + 0.35, b))  # right (+x)
    return np.array(pts, dtype=np.float64)


def make_synthetic_scene(
    n_views: int = 8,
    height: int = 96,
    width: int = 96,
    seed: int = 0,
    distortion=None,
    focal_factor: float = 1.1,
) -> SyntheticScene:
    """Render the deterministic synthetic scene from ``n_views`` poses on an arc looking at it.

    Args:
        n_views: number of camera views (arc of ±~69° for overlap + baseline).
        height, width: image size (small keeps downstream suites fast).
        seed: seeds the procedural texture (deterministic; identical across runs).
        distortion: optional Brown-Conrady ``[k1, k2, p1, p2]`` — also renders ``images_distorted``.
        focal_factor: focal length as a multiple of the long edge.
    """
    focal = focal_factor * max(height, width)
    K = np.array([[focal, 0.0, width / 2.0], [0.0, focal, height / 2.0], [0.0, 0.0, 1.0]])
    angles = np.linspace(-_CAM_ARC, _CAM_ARC, n_views)
    poses = np.stack(
        [
            look_at((_CAM_RADIUS * np.sin(a), _CAM_HEIGHT, -_CAM_RADIUS * np.cos(a)), _TARGET)
            for a in angles
        ],
        axis=0,
    )

    images = np.zeros((n_views, height, width, 3), dtype=np.uint8)
    depths = np.zeros((n_views, height, width), dtype=np.float64)
    for i in range(n_views):
        images[i], depths[i] = _render(poses[i], K, height, width, seed)

    dist_arr = None if distortion is None else np.asarray(distortion, dtype=np.float64)
    images_distorted = None
    if dist_arr is not None:
        images_distorted = np.zeros_like(images)
        for i in range(n_views):
            images_distorted[i], _ = _render(poses[i], K, height, width, seed, dist=dist_arr)

    points3d = _landmarks()
    visibility: list = []
    points_rgb = np.zeros((points3d.shape[0], 3), dtype=np.uint8)
    for m in range(points3d.shape[0]):
        obs = []
        colors = []
        for view in range(n_views):
            uv, depth = project_points(points3d[m : m + 1], K, poses[view])
            u, v = uv[0]
            d = depth[0]
            if d <= 0 or not (0.5 <= u < width - 0.5 and 0.5 <= v < height - 0.5):
                continue
            buf = depths[view, int(round(v)), int(round(u))]
            if np.isfinite(buf) and abs(buf - d) < 0.02 * d:  # front surface at this pixel ⇒ visible
                obs.append((view, float(u), float(v)))
                colors.append(images[view, int(round(v)), int(round(u))])
        visibility.append(obs)
        if colors:
            points_rgb[m] = np.rint(np.mean(colors, axis=0)).astype(np.uint8)

    return SyntheticScene(
        images=images,
        K=K,
        poses_w2c=poses,
        depths=depths,
        points3d=points3d,
        points_rgb=points_rgb,
        visibility=visibility,
        images_distorted=images_distorted,
        dist_coeffs=dist_arr,
    )
