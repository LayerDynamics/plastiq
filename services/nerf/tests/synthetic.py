"""Synthetic multi-view ground truth — a reproducible scene the NeRF/SDF training fits (no COLMAP).

A known sphere at the origin, coloured by surface normal (0.5+0.5·n), rendered from cameras on a ring
looking at the origin. Rays come from the MLX `generate_rays` (so training sees the same geometry); the
analytic ray–sphere intersection + shading is plain numpy ground truth. Deterministic.
"""

from __future__ import annotations

import numpy as np

from app.data_processing.rays import generate_rays


def look_at(eye, target=(0.0, 0.0, 0.0), up=(0.0, 1.0, 0.0)) -> np.ndarray:
    """A camera-to-world matrix (+z forward convention, matching rays.py) looking from `eye` at `target`."""
    eye, target, up = np.asarray(eye, float), np.asarray(target, float), np.asarray(up, float)
    forward = target - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(up, forward)
    right /= np.linalg.norm(right)
    true_up = np.cross(forward, right)
    c2w = np.eye(4, dtype=np.float32)
    c2w[:3, 0], c2w[:3, 1], c2w[:3, 2], c2w[:3, 3] = right, true_up, forward, eye
    return c2w


def render_sphere(c2w, fx, fy, cx, cy, h, w, center=(0, 0, 0), radius=1.0) -> np.ndarray:
    """Analytic ray–sphere render → `(H, W, 3)` image in [0,1] (normal-as-colour; black background)."""
    origins, dirs = generate_rays(c2w, fx, fy, cx, cy, h, w)
    o, d = np.asarray(origins), np.asarray(dirs)
    center = np.asarray(center, float)
    oc = o - center
    b = 2.0 * np.sum(d * oc, axis=1)
    c = np.sum(oc * oc, axis=1) - radius**2
    disc = b * b - 4.0 * c
    t = np.where(disc >= 0, (-b - np.sqrt(np.maximum(disc, 0.0))) / 2.0, np.inf)
    hit = (disc >= 0) & (t > 0)
    t = np.where(hit, t, 0.0)  # avoid inf·dir on missed rays (those pixels stay background)
    img = np.zeros((h * w, 3), dtype=np.float32)
    normal = (o + t[:, None] * d - center) / radius
    img[hit] = (0.5 + 0.5 * normal)[hit]
    return img.reshape(h, w, 3)


def make_synthetic_dataset(n_views=6, h=24, w=24, cam_radius=3.0, sphere_radius=1.0):
    """N ring-cameras around a sphere → (images `(N,H,W,3)`, poses `(N,4,4)`, intrinsics dict,
    transforms.json-style dict). Deterministic."""
    fx = fy = float(w)
    cx, cy = w / 2.0, h / 2.0
    images, poses, frames = [], [], []
    for i in range(n_views):
        a = 2.0 * np.pi * i / n_views
        eye = (cam_radius * np.cos(a), 0.6, cam_radius * np.sin(a))
        c2w = look_at(eye)
        images.append(render_sphere(c2w, fx, fy, cx, cy, h, w, radius=sphere_radius))
        poses.append(c2w)
        frames.append({"file_path": f"view_{i}.png", "transform_matrix": c2w.tolist()})
    intrinsics = {"fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": w, "height": h}
    transforms = {"w": w, "h": h, "fl_x": fx, "fl_y": fy, "cx": cx, "cy": cy, "frames": frames}
    return np.asarray(images), np.asarray(poses), intrinsics, transforms
