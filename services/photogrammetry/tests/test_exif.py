"""Tests for app/exif.py — the EXIF intrinsics prior (P1.1). MLX-free."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from app.exif import PinholeCamera, intrinsics_prior


def _jpeg_with_focal35(width: int, height: int, focal35: int) -> bytes:
    """A JPEG carrying FocalLengthIn35mmFilm (tag 41989) in its Exif sub-IFD, as real cameras do."""
    img = Image.fromarray(np.zeros((height, width, 3), dtype=np.uint8))
    exif = img.getexif()
    exif[0x8769] = {41989: focal35}  # ExifIFD → FocalLengthIn35mmFilm
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    return buf.getvalue()


def _jpeg_no_exif(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.zeros((height, width, 3), dtype=np.uint8)).save(buf, format="JPEG")
    return buf.getvalue()


def test_focal_35mm_equiv_to_pixels():
    w, h, f35 = 1920, 1080, 50
    fx, fy, cx, cy = intrinsics_prior(_jpeg_with_focal35(w, h, f35), w, h)
    expected = f35 * max(w, h) / 36.0  # 50 * 1920 / 36
    assert fx == pytest.approx(expected, rel=1e-9)
    assert fy == pytest.approx(expected, rel=1e-9)
    assert cx == pytest.approx(w / 2.0)
    assert cy == pytest.approx(h / 2.0)


def test_fallback_when_no_exif():
    w, h = 1600, 1200
    fx, fy, cx, cy = intrinsics_prior(_jpeg_no_exif(w, h), w, h)
    assert fx == pytest.approx(1.2 * max(w, h))
    assert fy == pytest.approx(1.2 * max(w, h))
    assert (cx, cy) == pytest.approx((w / 2.0, h / 2.0))


def test_focal_mm_with_sensor_width():
    # FocalLength (mm) + a known sensor width → f_px = f_mm * max(w,h) / sensor_mm.
    w, h = 4000, 3000
    img = Image.fromarray(np.zeros((h, w, 3), dtype=np.uint8))
    exif = img.getexif()
    exif[0x8769] = {37386: 24.0}  # FocalLength = 24 mm
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    fx, fy, cx, cy = intrinsics_prior(buf.getvalue(), w, h, sensor_width_mm=36.0)
    assert fx == pytest.approx(24.0 * max(w, h) / 36.0, rel=1e-9)


def test_accepts_pil_image_and_path(tmp_path):
    w, h, f35 = 800, 600, 30
    data = _jpeg_with_focal35(w, h, f35)
    # bytes, a PIL.Image, and a filesystem path must all resolve to the same intrinsics.
    from_bytes = intrinsics_prior(data, w, h)
    from_pil = intrinsics_prior(Image.open(io.BytesIO(data)), w, h)
    p = tmp_path / "frame.jpg"
    p.write_bytes(data)
    from_path = intrinsics_prior(str(p), w, h)
    assert from_bytes == pytest.approx(from_pil)
    assert from_bytes == pytest.approx(from_path)


def test_degenerate_size_raises():
    with pytest.raises(ValueError):
        intrinsics_prior(_jpeg_no_exif(64, 64), 0, 64)
    with pytest.raises(ValueError):
        intrinsics_prior(_jpeg_no_exif(64, 64), 64, -1)


def test_pinhole_camera_projects_consistently():
    cam = PinholeCamera(fx=1000.0, fy=1000.0, cx=320.0, cy=240.0)
    K = cam.K
    assert K.shape == (3, 3)
    assert K[0, 0] == 1000.0 and K[0, 2] == 320.0 and K[2, 2] == 1.0
    # A camera-space point (X, Y, Z) projects to (fx X/Z + cx, fy Y/Z + cy).
    xc = np.array([[0.5, -0.25, 2.0]])
    uv = cam.project_camera_points(xc)
    assert uv[0, 0] == pytest.approx(1000.0 * 0.5 / 2.0 + 320.0)
    assert uv[0, 1] == pytest.approx(1000.0 * -0.25 / 2.0 + 240.0)


def _jpeg_with_model_and_focal(width, height, make, model, focal_mm) -> bytes:
    """A JPEG carrying Make/Model (IFD0) + FocalLength in mm (Exif sub-IFD), but NO 35mm-equiv tag."""
    img = Image.fromarray(np.zeros((height, width, 3), dtype=np.uint8))
    exif = img.getexif()
    exif[271] = make   # Make
    exif[272] = model  # Model
    exif[0x8769] = {37386: focal_mm}  # ExifIFD → FocalLength (mm)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    return buf.getvalue()


def test_sensor_width_db_gives_focal_when_no_35mm_tag():
    # Canon IXUS 70 (Stone_Mask/Gorsedd_Stone gate camera): FocalLength mm + model → sensor-DB focal.
    w, h, f_mm = 3072, 2304, 17.4
    fx, fy, cx, cy = intrinsics_prior(
        _jpeg_with_model_and_focal(w, h, "Canon", "Canon DIGITAL IXUS 70", f_mm), w, h
    )
    expected = f_mm * max(w, h) / 5.75  # sensor width from _SENSOR_WIDTH_DB
    assert fx == pytest.approx(expected, rel=1e-9)
    # And it is far from the wide fallback (proving the DB path fired, not the guess).
    assert abs(fx - 1.2 * max(w, h)) > 1000.0


def test_explicit_sensor_width_overrides_db():
    w, h, f_mm = 3072, 2304, 17.4
    fx, _, _, _ = intrinsics_prior(
        _jpeg_with_model_and_focal(w, h, "Canon", "Canon DIGITAL IXUS 70", f_mm), w, h,
        sensor_width_mm=6.0,
    )
    assert fx == pytest.approx(f_mm * max(w, h) / 6.0, rel=1e-9)


def test_unknown_camera_falls_back():
    w, h = 3072, 2304
    fx, _, _, _ = intrinsics_prior(
        _jpeg_with_model_and_focal(w, h, "Nokia", "Totally Unknown Cam 9000", 5.0), w, h
    )
    assert fx == pytest.approx(1.2 * max(w, h))  # not in the DB, no explicit width → fallback


def test_real_stone_mask_focal_via_sensor_db():
    """On a real Canon IXUS 70 gate photo (no 35mm-equiv EXIF), the sensor-DB focal is sane and far
    from the wide fallback (skip-if-absent)."""
    import os
    stone = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
        "ref", "Photogrammetry-examples", "Stone_Mask", "images",
    )
    if not os.path.isdir(stone):
        pytest.skip("ref/Photogrammetry-examples not present")
    names = sorted(n for n in os.listdir(stone) if n.lower().endswith((".jpg", ".jpeg")))
    p = os.path.join(stone, names[0])
    w, h = Image.open(p).size
    fx, fy, cx, cy = intrinsics_prior(p, w, h)
    assert fx > 1.5 * max(w, h)  # a real ~17mm-on-5.75mm-sensor focal is well above the wide fallback
    assert np.isfinite(fx) and cx == w / 2.0 and cy == h / 2.0
