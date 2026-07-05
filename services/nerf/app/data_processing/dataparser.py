"""transforms.json ingestion (N5) — the nerfstudio/COLMAP/Blender pose convention. Parsing is plain
numpy I/O (not a model). SfM (photos → poses) is COLMAP's job, upstream; we ingest its
`transforms.json`. Poses arrive in OpenGL camera axes (−z forward, +y up); `parse_transforms`
converts each c2w to the internal +z-forward (OpenCV) axes `rays.py` consumes (SPEC-13 FR-9).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class DataparserOutputs:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int
    poses: np.ndarray  # (N, 4, 4) camera-to-world
    images: np.ndarray | None  # (N, H, W, 3) in [0,1], or None if not loaded here


def parse_transforms(transforms: dict, images: np.ndarray | None = None) -> DataparserOutputs:
    """Parse a `transforms.json` dict → intrinsics + per-frame c2w poses. Intrinsics come from
    `fl_x/fl_y/cx/cy` when present, else are derived from `camera_angle_x` (the Blender FOV)."""
    width = int(transforms.get("w") or transforms.get("width") or 0)
    height = int(transforms.get("h") or transforms.get("height") or 0)
    if "fl_x" in transforms:
        fx, fy = float(transforms["fl_x"]), float(transforms.get("fl_y", transforms["fl_x"]))
    elif "camera_angle_x" in transforms:
        # focal from FOV: fx = 0.5 W / tan(0.5 FOVx). Needs a real image size.
        if width <= 0 or height <= 0:
            raise ValueError("camera_angle_x intrinsics require a positive image width/height (w/h)")
        fx = 0.5 * width / math.tan(0.5 * float(transforms["camera_angle_x"]))
        if "camera_angle_y" in transforms:
            fy = 0.5 * height / math.tan(0.5 * float(transforms["camera_angle_y"]))
        else:
            fy = fx  # square pixels
    else:
        raise ValueError("transforms.json must define intrinsics via 'fl_x' or 'camera_angle_x'")
    cx = float(transforms.get("cx", width / 2))
    cy = float(transforms.get("cy", height / 2))
    if fx <= 0.0 or fy <= 0.0:
        raise ValueError(f"degenerate focal length (fx={fx}, fy={fy}) — check the transforms intrinsics")
    poses = np.asarray([np.asarray(f["transform_matrix"], dtype=np.float32) for f in transforms["frames"]])
    # transforms.json is the standard nerfstudio/COLMAP/Blender convention: c2w in OpenGL camera axes
    # (−z forward, +y up). rays.py uses the internal +z-forward (OpenCV) axes, so convert on load by
    # negating the camera y/z axis columns — the exact inverse of the photogrammetry emitter's flip
    # (round-trips). SPEC-13 §1/FR-9 + §6.2; SPEC-11 §5/FR-3 (2026-07-04 additive note).
    if poses.size:
        poses[:, 0:3, 1:3] *= -1.0
    return DataparserOutputs(fx=fx, fy=fy, cx=cx, cy=cy, width=width, height=height, poses=poses, images=images)


def load_transforms_file(path: str | Path) -> dict:
    """Read a transforms.json from disk."""
    return json.loads(Path(path).read_text())
