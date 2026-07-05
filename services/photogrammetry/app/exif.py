"""EXIF-based camera-intrinsics prior (SPEC-13 FR-2, P1.1).

Structure-from-Motion needs an initial focal length to seed bundle adjustment; a good prior speeds
convergence and avoids the focal/depth gauge ambiguity collapsing. Cameras record focal length in
EXIF, so we read it and convert to pixels; absent EXIF we fall back to a generous wide-angle guess
(``1.2 · max(w, h)``) that BA then refines (self-calibration, SPEC-13 §5.4-3).

MLX-free by construction (numpy + pillow only): the CI photogrammetry row imports this module, so it
must not pull in MLX (NFR-4). This module never imports cv2 (the test-only oracle, D-1).
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

# EXIF tag numbers (see EXIF 2.3 / TIFF): Make/Model are top-level IFD0; the focal tags live in the
# Exif sub-IFD (0x8769).
_EXIF_IFD = 0x8769
_MAKE = 271  # 0x010F
_MODEL = 272  # 0x0110
_FOCAL_LENGTH_IN_35MM = 41989  # 0xA405, integer, in mm (35mm-equivalent)
_FOCAL_LENGTH = 37386  # 0x920A, rational, in mm (actual)
# The full-frame reference the 35mm-equivalent focal is defined against.
_FULL_FRAME_WIDTH_MM = 36.0
# Fallback focal as a multiple of the image's long edge (~55° horizontal FoV) — a sane wide prior.
_FALLBACK_FOCAL_FACTOR = 1.2

# Camera-model → physical sensor width (mm). When a photo carries the real ``FocalLength`` (mm) but
# no 35mm-equivalent tag (common on compacts/older cameras, e.g. the Canon IXUS gate datasets), the
# focal in pixels is ``f_mm · max(w, h) / sensor_width_mm`` — far more accurate than the wide
# fallback. Keyed by the normalized EXIF model string (brand prefix included as cameras report it).
# Curated from the openMVG ``sensor_width_camera_database.txt`` (the full ~3000-entry DB drops in
# here unchanged if wider coverage is ever needed); sensor widths are public manufacturer facts.
_SENSOR_WIDTH_DB = {
    "CANON DIGITAL IXUS 70": 5.75,      # 1/2.5" — the Stone_Mask / Gorsedd_Stone gate datasets
    "CANON DIGITAL IXUS 700": 7.11,
    "NIKON D3100": 23.1,                # APS-C (also carries 35mm-equiv, listed for completeness)
    "NIKON D3200": 23.2,
    "NIKON D5300": 23.5,
    "CANON EOS 5D MARK III": 36.0,
    "CANON EOS 5D MARK IV": 36.0,
    "CANON EOS 60D": 22.3,
    "CANON EOS 70D": 22.5,
    "CANON EOS REBEL T3I": 22.3,
    "SONY ILCE-6000": 23.5,
    "SONY ILCE-7M3": 35.8,
    "PANASONIC DMC-GH4": 17.3,
    "FUJIFILM X-T3": 23.5,
}

__all__ = ["PinholeCamera", "intrinsics_prior"]


@dataclass(frozen=True)
class PinholeCamera:
    """A pinhole camera: focal lengths and principal point in pixels."""

    fx: float
    fy: float
    cx: float
    cy: float

    @property
    def K(self) -> np.ndarray:
        return np.array(
            [[self.fx, 0.0, self.cx], [0.0, self.fy, self.cy], [0.0, 0.0, 1.0]], dtype=np.float64
        )

    def project_camera_points(self, points_cam: np.ndarray) -> np.ndarray:
        """Project ``(N, 3)`` camera-space points to ``(N, 2)`` pixels (perspective divide)."""
        p = np.asarray(points_cam, dtype=np.float64)
        if p.ndim != 2 or p.shape[1] != 3:
            raise ValueError(f"points_cam must be (N, 3); got {p.shape}")
        z = p[:, 2]
        u = self.fx * p[:, 0] / z + self.cx
        v = self.fy * p[:, 1] / z + self.cy
        return np.stack([u, v], axis=1)


def _load_image(image) -> Image.Image:
    """Accept a PIL.Image, raw bytes, or a filesystem path → a PIL.Image."""
    if isinstance(image, Image.Image):
        return image
    if isinstance(image, (bytes, bytearray)):
        return Image.open(io.BytesIO(bytes(image)))
    if isinstance(image, (str, Path)):
        return Image.open(Path(image))
    raise TypeError(f"image must be a PIL.Image, bytes, or path; got {type(image).__name__}")


def _read_focal_tags(image: Image.Image) -> tuple[float | None, float | None]:
    """Return ``(focal_35mm, focal_mm)`` from EXIF, checking both the top-level and Exif sub-IFD.

    Either may be ``None`` if the tag is absent or non-positive. Values are coerced to float (EXIF
    rationals arrive as ``IFDRational``, which floats cleanly)."""
    try:
        exif = image.getexif()
    except (AttributeError, OSError):
        return None, None
    if not exif:
        return None, None
    sub = {}
    try:
        sub = dict(exif.get_ifd(_EXIF_IFD))
    except (KeyError, OSError, ValueError):
        sub = {}

    def _get(tag: int) -> float | None:
        val = sub.get(tag, exif.get(tag))
        if val is None:
            return None
        try:
            f = float(val)
        except (TypeError, ValueError):
            return None
        return f if f > 0.0 else None

    return _get(_FOCAL_LENGTH_IN_35MM), _get(_FOCAL_LENGTH)


def _read_camera_model(image: Image.Image) -> str | None:
    """Return the normalized ``"MAKE MODEL"`` EXIF string (uppercased, whitespace-collapsed), or None.

    The model tag usually already includes the brand (e.g. ``"Canon DIGITAL IXUS 70"``); when it does
    not, the make is prefixed so the key matches the openMVG-style ``Make Model`` convention."""
    try:
        exif = image.getexif()
    except (AttributeError, OSError):
        return None
    if not exif:
        return None
    make = exif.get(_MAKE)
    model = exif.get(_MODEL)
    if not model:
        return None
    model = str(model).strip()
    make = str(make).strip() if make else ""
    combined = model if (not make or model.upper().startswith(make.upper())) else f"{make} {model}"
    return " ".join(combined.upper().split())


def _lookup_sensor_width(image: Image.Image) -> float | None:
    """Physical sensor width (mm) for the photo's camera from :data:`_SENSOR_WIDTH_DB`, or None."""
    key = _read_camera_model(image)
    return _SENSOR_WIDTH_DB.get(key) if key else None


def intrinsics_prior(image, width: int, height: int, sensor_width_mm: float | None = None):
    """Estimate ``(fx, fy, cx, cy)`` in pixels for a photo of size ``width × height``.

    Priority: (1) EXIF 35mm-equivalent focal → ``f_px = f35 · max(w, h) / 36``; (2) EXIF focal in mm
    with a sensor width — an explicit ``sensor_width_mm`` if given, else looked up from the camera
    model in :data:`_SENSOR_WIDTH_DB` — → ``f_px = f_mm · max(w, h) / sensor_width_mm``; (3) fallback
    ``f_px = 1.2 · max(w, h)``. Square pixels (``fx == fy``); principal point at the image centre.

    Args:
        image: a PIL.Image, raw image bytes, or a filesystem path.
        width, height: the image dimensions in pixels (must be positive).
        sensor_width_mm: physical sensor width; overrides the model-DB lookup when the 35mm-
            equivalent tag is absent.

    Returns:
        ``(fx, fy, cx, cy)`` floats.
    """
    if width <= 0 or height <= 0:
        raise ValueError(f"width and height must be positive; got {width}x{height}")

    long_edge = float(max(width, height))
    img = _load_image(image)
    focal_35mm, focal_mm = _read_focal_tags(img)
    if sensor_width_mm is None:
        sensor_width_mm = _lookup_sensor_width(img)  # from the camera model, when available

    if focal_35mm is not None:
        f_px = focal_35mm * long_edge / _FULL_FRAME_WIDTH_MM
    elif focal_mm is not None and sensor_width_mm is not None and sensor_width_mm > 0.0:
        f_px = focal_mm * long_edge / sensor_width_mm
    else:
        f_px = _FALLBACK_FOCAL_FACTOR * long_edge

    cx = width / 2.0
    cy = height / 2.0
    return f_px, f_px, cx, cy
