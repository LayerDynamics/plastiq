"""transforms.json ingestion (N5) — the nerfstudio/Blender pose convention. Parsing is plain numpy
I/O (not a model). SfM (photos → poses) is COLMAP's job, upstream; we ingest its `transforms.json`.
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
    else:
        # fx = 0.5 W / tan(0.5 FOVx)
        fx = 0.5 * width / math.tan(0.5 * float(transforms["camera_angle_x"]))
        fy = float(transforms.get("camera_angle_y") and 0.5 * height / math.tan(0.5 * transforms["camera_angle_y"]) or fx)
    cx = float(transforms.get("cx", width / 2))
    cy = float(transforms.get("cy", height / 2))
    poses = np.asarray([np.asarray(f["transform_matrix"], dtype=np.float32) for f in transforms["frames"]])
    return DataparserOutputs(fx=fx, fy=fy, cx=cx, cy=cy, width=width, height=height, poses=poses, images=images)


def load_transforms_file(path: str | Path) -> dict:
    """Read a transforms.json from disk."""
    return json.loads(Path(path).read_text())
