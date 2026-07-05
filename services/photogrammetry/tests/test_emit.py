"""Tests for the emission contracts (SPEC-13 §6.2/§6.3, FR-3/D-4/D-5/D-6; plan P6.3).

``app.emit`` is the producer boundary: it turns solved poses + shared intrinsics into a
nerfstudio-convention ``transforms.json`` string (OpenGL camera axes — the D-4 flip) and writes ASCII
PLY point clouds in the exact property layout the downstream parsers expect. Two real consumers pin
its correctness:

  * ``services/nerf``'s ``parse_transforms`` — the emitted JSON is parsed by the *actual* sibling
    service code (loaded by file path via importlib, since ``services/nerf`` also ships an ``app``
    package that would clash with ours on ``sys.path``); intrinsics and per-frame camera-to-world
    poses must survive the round-trip.
  * ``packages/capture/src/pointcloud.ts`` — the PLY header property order (``x y z`` for sparse,
    ``x y z nx ny nz`` for dense) is what that parser reads *by position*; a tiny in-test ASCII-PLY
    reader mirrors its expectations and round-trips the written clouds.

``emit.py`` sits on the NFR-4 CI import seam alongside ``normalize``/``exif``/``jobs`` and must import
without MLX — asserted in a fresh subprocess so the check targets this module's own import chain.

The committed ``tests/fixtures/dense_sample.ply`` is (re)emitted here via ``write_ply_dense`` so P11's
vitest cross-parse has a valid on-disk dense cloud to read.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

from app.emit import emit_transforms_json, write_ply_dense, write_ply_sparse
from tests.synthetic import make_synthetic_scene

_SERVICE_ROOT = Path(__file__).resolve().parents[1]
_FIXTURES = Path(__file__).resolve().parent / "fixtures"
# services/photogrammetry/tests/ → parents[2] == services/ ; the sibling nerf dataparser file.
_NERF_DATAPARSER = (
    Path(__file__).resolve().parents[2] / "nerf" / "app" / "data_processing" / "dataparser.py"
)


def _scene():
    return make_synthetic_scene(n_views=6, height=64, width=64, seed=0)


def _image_names(n: int) -> list[str]:
    return [f"IMG_{i:04d}.jpg" for i in range(n)]


def _load_nerf_parse_transforms():
    """Import the REAL ``services/nerf`` ``parse_transforms`` by file path.

    A plain ``from app.data_processing.dataparser import parse_transforms`` cannot work: this
    service *also* has a top-level ``app`` package, so ``app`` on ``sys.path`` resolves to ours, not
    nerf's. ``dataparser.py`` has no intra-package imports (only stdlib + numpy), so loading it as a
    standalone module by absolute file path is safe and needs no ``services/nerf`` on ``sys.path``.
    """
    assert _NERF_DATAPARSER.is_file(), f"nerf dataparser not found at {_NERF_DATAPARSER}"
    spec = importlib.util.spec_from_file_location("nerf_dataparser_contract", _NERF_DATAPARSER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before exec: `DataparserOutputs` is a `@dataclass` under `from __future__ import
    # annotations`, and dataclass field processing resolves the module via `sys.modules[__module__]`.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.parse_transforms


# --- tiny in-test ASCII-PLY reader (mirrors packages/capture/src/pointcloud.ts by property order) --


def _read_ply_ascii(text: str) -> dict:
    """Parse an ASCII PLY the way ``pointcloud.ts`` does: read the vertex element's property names
    in order, then read each data row and pick columns by the index of ``x/y/z`` (+ ``nx/ny/nz`` and
    ``red/green/blue`` when present). Returns ``{points, normals?, colors?}`` as numpy arrays."""
    raw = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in raw if ln != ""]
    it = iter(lines)
    assert next(it) == "ply", "missing 'ply' magic"
    elements: list[dict] = []
    fmt_seen = False
    for line in it:
        if line == "end_header":
            break
        parts = line.split()
        if parts[0] in ("comment", "obj_info"):
            continue
        if parts[0] == "format":
            assert parts[1] == "ascii", f"binary PLY not supported: {parts[1]}"
            fmt_seen = True
            continue
        if parts[0] == "element":
            elements.append({"name": parts[1], "count": int(parts[2]), "props": []})
            continue
        if parts[0] == "property":
            elements[-1]["props"].append(parts[-1])
            continue
        raise AssertionError(f"unrecognized header line: {line}")
    assert fmt_seen, "header has no 'format' line"

    vidx = next(i for i, e in enumerate(elements) if e["name"] == "vertex")
    vertex = elements[vidx]
    props = vertex["props"]
    xi, yi, zi = props.index("x"), props.index("y"), props.index("z")
    has_normals = all(p in props for p in ("nx", "ny", "nz"))
    has_colors = all(p in props for p in ("red", "green", "blue"))

    data = list(it)
    # skip any elements declared before vertex (none here, but mirror the parser's positional skip).
    cursor = sum(elements[e]["count"] for e in range(vidx))
    points, normals, colors = [], [], []
    for r in range(vertex["count"]):
        cols = data[cursor + r].split()
        points.append([float(cols[xi]), float(cols[yi]), float(cols[zi])])
        if has_normals:
            ni, nj, nk = props.index("nx"), props.index("ny"), props.index("nz")
            normals.append([float(cols[ni]), float(cols[nj]), float(cols[nk])])
        if has_colors:
            ri, gi, bi = props.index("red"), props.index("green"), props.index("blue")
            colors.append([int(cols[ri]), int(cols[gi]), int(cols[bi])])
    out: dict = {"points": np.asarray(points, dtype=np.float64)}
    if has_normals:
        out["normals"] = np.asarray(normals, dtype=np.float64)
    if has_colors:
        out["colors"] = np.asarray(colors, dtype=np.int64)
    return out


# --- transforms.json emission ---------------------------------------------------------------------


def test_emitted_json_parses_through_real_nerf_parser():
    """The emitted transforms.json is consumed by the ACTUAL services/nerf parse_transforms:
    intrinsics survive and every per-frame pose round-trips back to the solver w2c pose.

    The FR-9 lockstep (SPEC-13 §6.2) makes the emitter and the nerf parser mirror each other: the
    emitter converts internal OpenCV w2c → OpenGL c2w (``inv(w2c)`` then ``c2w[0:3,1:3] *= -1``), and
    ``parse_transforms`` applies the exact inverse flip on load, so ``out.poses[i]`` comes back as the
    internal OpenCV c2w ``inv(w2c)``. Its inverse is therefore the original solver ``[R|t]``. The
    camera *center* (``out.poses[i][:3,3]``) is asserted separately as a convention-independent anchor
    — the y/z-column flip never touches the translation column, so that check holds regardless of the
    parser's axis convention."""
    s = _scene()
    names = _image_names(s.poses_w2c.shape[0])
    js = emit_transforms_json(s.poses_w2c, s.K, 64, 64, names)
    parse_transforms = _load_nerf_parse_transforms()
    out = parse_transforms(json.loads(js))

    assert out.width == 64 and out.height == 64
    assert abs(out.fx - float(s.K[0, 0])) < 1e-4
    assert abs(out.fy - float(s.K[1, 1])) < 1e-4
    assert abs(out.cx - float(s.K[0, 2])) < 1e-4
    assert abs(out.cy - float(s.K[1, 2])) < 1e-4
    assert out.poses.shape == (s.poses_w2c.shape[0], 4, 4)

    for i, pose in enumerate(s.poses_w2c):
        pose = np.asarray(pose, dtype=np.float64)
        R, t = pose[:, :3], pose[:, 3]
        expected_w2c = np.eye(4)
        expected_w2c[:3, :4] = pose
        c2w = np.asarray(out.poses[i], dtype=np.float64)  # internal OpenCV c2w after the parser flip
        # Camera center C solves R C + t = 0 ⇒ C = -Rᵀ t; it is column 3 of any c2w (flip-invariant).
        assert np.allclose(c2w[:3, 3], -R.T @ t, atol=1e-4), f"frame {i} camera center off"
        assert np.allclose(np.linalg.inv(c2w), expected_w2c, atol=1e-4), f"frame {i} c2w did not round-trip"


def test_frame_file_paths_and_camera_model():
    s = _scene()
    names = _image_names(s.poses_w2c.shape[0])
    doc = json.loads(emit_transforms_json(s.poses_w2c, s.K, 64, 64, names))
    assert doc["camera_model"] == "OPENCV"
    assert [f["file_path"] for f in doc["frames"]] == [f"./images/{n}" for n in names]
    assert len(doc["frames"]) == s.poses_w2c.shape[0]


def test_undistort_true_zeroes_distortion():
    s = _scene()
    names = _image_names(s.poses_w2c.shape[0])
    dist = np.array([-0.12, 0.03, 0.001, -0.002])
    doc = json.loads(emit_transforms_json(s.poses_w2c, s.K, 64, 64, names, dist=dist, undistort=True))
    assert doc["k1"] == 0.0 and doc["k2"] == 0.0 and doc["p1"] == 0.0 and doc["p2"] == 0.0


def test_undistort_false_keeps_calibrated_coeffs():
    s = _scene()
    names = _image_names(s.poses_w2c.shape[0])
    dist = np.array([-0.12, 0.03, 0.001, -0.002])
    doc = json.loads(emit_transforms_json(s.poses_w2c, s.K, 64, 64, names, dist=dist, undistort=False))
    assert abs(doc["k1"] - (-0.12)) < 1e-12
    assert abs(doc["k2"] - 0.03) < 1e-12
    assert abs(doc["p1"] - 0.001) < 1e-12
    assert abs(doc["p2"] - (-0.002)) < 1e-12


def test_applied_transform_included_when_given():
    s = _scene()
    names = _image_names(s.poses_w2c.shape[0])
    applied = np.array([[2.0, 0.0, 0.0, 1.0], [0.0, 2.0, 0.0, -1.0], [0.0, 0.0, 2.0, 0.5]])
    doc = json.loads(emit_transforms_json(s.poses_w2c, s.K, 64, 64, names, applied_transform=applied))
    assert "applied_transform" in doc
    assert np.allclose(np.asarray(doc["applied_transform"]), applied)
    # Omitted when not supplied.
    doc2 = json.loads(emit_transforms_json(s.poses_w2c, s.K, 64, 64, names))
    assert "applied_transform" not in doc2


def test_reproj_errors_emitted_per_frame():
    s = _scene()
    n = s.poses_w2c.shape[0]
    names = _image_names(n)
    errs = [0.1 * (i + 1) for i in range(n)]
    doc = json.loads(emit_transforms_json(s.poses_w2c, s.K, 64, 64, names, reproj_errors=errs))
    got = [f["reproj_error_px"] for f in doc["frames"]]
    assert np.allclose(got, errs)
    # Absent when not supplied.
    doc2 = json.loads(emit_transforms_json(s.poses_w2c, s.K, 64, 64, names))
    assert all("reproj_error_px" not in f for f in doc2["frames"])


def test_names_length_must_match_poses():
    s = _scene()
    try:
        emit_transforms_json(s.poses_w2c, s.K, 64, 64, _image_names(s.poses_w2c.shape[0] - 1))
    except ValueError:
        pass
    else:
        raise AssertionError("expected a ValueError on names/poses length mismatch")


def test_emit_is_deterministic():
    s = _scene()
    names = _image_names(s.poses_w2c.shape[0])
    a = emit_transforms_json(s.poses_w2c, s.K, 64, 64, names)
    b = emit_transforms_json(s.poses_w2c, s.K, 64, 64, names)
    assert a == b


def test_json_is_numpy_serialisable():
    """Emission must not leak numpy scalars (json.dumps would raise) — the string is valid JSON."""
    s = _scene()
    names = _image_names(s.poses_w2c.shape[0])
    js = emit_transforms_json(s.poses_w2c, s.K, 64, 64, names, applied_transform=np.eye(4)[:3, :])
    json.loads(js)  # round-trips cleanly


# --- PLY writers ----------------------------------------------------------------------------------


def test_sparse_ply_roundtrips_xyz_and_colors():
    rng = np.random.default_rng(0)
    points = rng.normal(size=(25, 3))
    colors = rng.integers(0, 256, size=(25, 3))
    buf = io.StringIO()
    write_ply_sparse(buf, points, colors)
    parsed = _read_ply_ascii(buf.getvalue())
    assert parsed["points"].shape == (25, 3)
    assert np.allclose(parsed["points"], points, atol=1e-6)
    assert "normals" not in parsed  # sparse cloud carries no normals
    assert np.array_equal(parsed["colors"], colors)


def test_dense_ply_roundtrips_xyz_normals_colors():
    rng = np.random.default_rng(1)
    points = rng.normal(size=(30, 3))
    normals = rng.normal(size=(30, 3))
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    colors = rng.integers(0, 256, size=(30, 3))
    buf = io.StringIO()
    write_ply_dense(buf, points, normals, colors)
    parsed = _read_ply_ascii(buf.getvalue())
    assert parsed["points"].shape == (30, 3)
    assert "normals" in parsed and parsed["normals"].shape == (30, 3)
    assert np.allclose(parsed["points"], points, atol=1e-6)
    assert np.allclose(parsed["normals"], normals, atol=1e-6)
    assert np.array_equal(parsed["colors"], colors)


def test_dense_ply_header_property_order():
    """Dense header must be x y z nx ny nz red green blue (pointcloud.ts reads by position)."""
    buf = io.StringIO()
    write_ply_dense(buf, np.zeros((1, 3)), np.array([[0.0, 0.0, 1.0]]), np.array([[10, 20, 30]]))
    props = [ln.split()[-1] for ln in buf.getvalue().splitlines() if ln.startswith("property")]
    assert props == ["x", "y", "z", "nx", "ny", "nz", "red", "green", "blue"]


def test_ply_writers_accept_path(tmp_path):
    points = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
    colors = np.array([[1, 2, 3], [4, 5, 6]])
    p = tmp_path / "sparse.ply"
    write_ply_sparse(p, points, colors)
    parsed = _read_ply_ascii(p.read_text())
    assert np.allclose(parsed["points"], points)


def test_emits_committed_dense_fixture():
    """Emit the committed tests/fixtures/dense_sample.ply (P11 vitest cross-parse) and verify it is a
    valid dense cloud with normals via the in-test reader."""
    _FIXTURES.mkdir(parents=True, exist_ok=True)
    # A small deterministic dense cloud: points on the unit box, outward unit normals, gray colors.
    pts = np.array(
        [
            [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 1.0],
        ],
        dtype=np.float64,
    )
    normals = pts - pts.mean(axis=0)
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)
    colors = np.full((pts.shape[0], 3), 128, dtype=np.int64)
    target = _FIXTURES / "dense_sample.ply"
    write_ply_dense(target, pts, normals, colors)

    parsed = _read_ply_ascii(target.read_text())
    assert parsed["points"].shape == (8, 3)
    assert parsed["normals"].shape == (8, 3)
    assert np.allclose(parsed["points"], pts, atol=1e-6)
    assert np.allclose(np.linalg.norm(parsed["normals"], axis=1), 1.0, atol=1e-6)


# --- CI import seam (NFR-4) -----------------------------------------------------------------------


def test_import_is_mlx_free():
    """`app.emit`'s own import chain must not load mlx (NFR-4 CI seam).

    Fresh subprocess so the assertion targets this module's imports, not mlx that another test
    (features/match/mvs) may have already loaded into the shared pytest process.
    """
    code = (
        "import sys, app.emit; "
        "bad = [m for m in sys.modules if m == 'mlx' or m.startswith('mlx.')]; "
        "assert not bad, bad"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(_SERVICE_ROOT),
        env={**os.environ, "PYTHONPATH": "."},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
