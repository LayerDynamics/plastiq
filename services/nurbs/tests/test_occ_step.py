"""U6.1 — tests for `app/occ_step.py`: validated NURBS JSON → OCCT → STEP.

The headline is **MLX-vs-OCCT D0/D1 parity**: the same validated `NurbsSurface`
evaluated by `app/core/eval.py` (flat knots) and by OCCT's `Geom_BSplineSurface`
(compact knots consumed DIRECTLY — SPEC-12 §6.2 invariant 5, no flattening) must
agree at 1e-9 (points) / 1e-7 (first derivatives) on a fixed 24-pair (u, v) grid.
That proves both the compact-knot handoff and the pole-grid orientation
(schema `poles[i][j]` ⇒ OCCT `Poles(i+1, j+1)`, i = u row — `Poles.ColLength()`
is OCCT's U pole count).

Fixtures are rebuilt locally from `test_eval.py`'s deterministic recipes:

* the wavy 5×6 non-rational net, degrees (2, 3), interior knots both directions —
  compact form: u [0, .4, .7, 1] × mults [3, 1, 1, 3]; v [0, .3, .6, 1] × [4, 1, 1, 4];
* the exact rational quarter cylinder (weights [1, √2/2, 1] in u). test_eval extrudes
  it at v-degree 1, but the §6.2 export gate is `2 <= degree <= 8` (schema MIN_DEGREE),
  so the v direction is **exactly degree-elevated** to 2: linear segment [P0, P1] ⇒
  Bezier [P0, (P0+P1)/2, P1] with the row weight repeated (elevation happens in
  homogeneous coordinates where the v rows are straight lines) — geometrically
  identical, and the on-cylinder self-check below asserts that exactness.

STEP conventions under test (SPEC-7 D-4 mirrored by SPEC-12): `STEPControl_AsIs`,
raw metre coordinates (no unit scaling), text re-imports via `STEPControl_Reader`
with the same face count. No conftest.py; everything deterministic, no RNG.
"""

import math
import re

import mlx.core as mx
import numpy as np
import pytest
from OCC.Core.gp import gp_Pnt, gp_Vec
from OCC.Core.IFSelect import IFSelect_RetDone
from OCC.Core.STEPControl import STEPControl_Reader
from OCC.Core.TopAbs import TopAbs_FACE
from OCC.Core.TopExp import TopExp_Explorer
from pydantic import ValidationError

import app.occ_step as occ_step
from app.core.eval import surface_derivs, surface_point
from app.occ_step import (
    build_bspline_surface,
    step_worker,
    surfaces_json_to_step,
    surfaces_to_solid_step,
    surfaces_to_step,
)
from app.schema import NurbsSurface, Surfaces

# --- fixture 1: wavy 5x6 non-rational net, degrees (2, 3) — test_eval recipe, compact knots --
NU, NV = 5, 6
P_U, Q_V = 2, 3


def _wavy_poles() -> list[list[list[float]]]:
    """test_eval's formula-built wavy control grid (deterministic, no RNG)."""
    return [
        [
            [i * 0.5, j * 0.4, math.sin(0.9 * i) * math.cos(0.7 * j) * 0.6]
            for j in range(NV)
        ]
        for i in range(NU)
    ]


def wavy_surface() -> NurbsSurface:
    # flat [0,0,0,.4,.7,1,1,1] / [0,0,0,0,.3,.6,1,1,1,1] in compact (OCCT) form
    return NurbsSurface(
        poles=_wavy_poles(),
        weights=[],
        u_knots=[0.0, 0.4, 0.7, 1.0],
        u_mults=[3, 1, 1, 3],
        v_knots=[0.0, 0.3, 0.6, 1.0],
        v_mults=[4, 1, 1, 4],
        u_degree=P_U,
        v_degree=Q_V,
    )


# --- fixture 2: exact rational quarter cylinder, v exactly degree-elevated 1 → 2 -------------
RADIUS, HEIGHT = 1.5, 2.0
W_MID = math.sqrt(2.0) / 2.0
_ARC = [[RADIUS, 0.0], [RADIUS, RADIUS], [0.0, RADIUS]]  # degree-2 quarter-circle xy poles
_ARC_W = [1.0, W_MID, 1.0]


def cylinder_surface() -> NurbsSurface:
    # v rows are straight lines with constant weight, so homogeneous degree elevation
    # inserts the exact midpoint pole with the same weight — geometry unchanged.
    poles = [
        [[x, y, 0.0], [x, y, HEIGHT / 2.0], [x, y, HEIGHT]] for x, y in _ARC
    ]
    weights = [[w, w, w] for w in _ARC_W]
    return NurbsSurface(
        poles=poles,
        weights=weights,
        u_knots=[0.0, 1.0],
        u_mults=[3, 3],
        v_knots=[0.0, 1.0],
        v_mults=[3, 3],
        u_degree=2,
        v_degree=2,
    )


# --- 24 fixed (u, v) pairs (test_eval recipe): corners, edges, knot lines, interior ----------
UV_PAIRS = [
    (0.0, 0.0), (0.0, 1.0), (1.0, 0.0), (1.0, 1.0),  # corners
    (0.0, 0.45), (1.0, 0.3), (0.35, 0.0), (0.62, 1.0),  # edges
    (0.4, 0.3), (0.4, 0.6), (0.7, 0.3), (0.7, 0.6),  # knot x knot (wavy)
    (0.4, 0.85), (0.7, 0.15), (0.2, 0.3), (0.9, 0.6),  # knot lines x interior
    (0.1, 0.1), (0.25, 0.5), (0.33, 0.77), (0.5, 0.25),
    (0.55, 0.9), (0.68, 0.42), (0.81, 0.63), (0.95, 0.05),  # interior
]


# --- helpers ---------------------------------------------------------------------------------


def _mx64(values) -> mx.array:
    # MLX silently downcasts float64 numpy input unless dtype is explicit (§5.3)
    return mx.array(np.asarray(values, dtype=np.float64), dtype=mx.float64)


def _mlx_eval(surface: NurbsSurface):
    """Evaluate the model with the MLX core (flat knots) at UV_PAIRS → (S, Su, Sv) numpy."""
    poles = _mx64(surface.poles)
    weights = _mx64(surface.weights) if surface.is_rational else None
    ku = _mx64(surface.flat_u_knots())
    kv = _mx64(surface.flat_v_knots())
    u = _mx64([u for u, _ in UV_PAIRS])
    v = _mx64([v for _, v in UV_PAIRS])
    pts = surface_point(poles, weights, ku, kv, surface.u_degree, surface.v_degree, u, v)
    ders = surface_derivs(poles, weights, ku, kv, surface.u_degree, surface.v_degree, u, v)
    return np.array(pts), np.array(ders.Su), np.array(ders.Sv)


def _occt_eval(occ_surf):
    """Evaluate the OCCT surface at UV_PAIRS via D1 → (S, Su, Sv) numpy."""
    s = np.empty((len(UV_PAIRS), 3))
    su = np.empty((len(UV_PAIRS), 3))
    sv = np.empty((len(UV_PAIRS), 3))
    for row, (u, v) in enumerate(UV_PAIRS):
        pnt, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
        occ_surf.D1(u, v, pnt, du, dv)
        s[row] = (pnt.X(), pnt.Y(), pnt.Z())
        su[row] = (du.X(), du.Y(), du.Z())
        sv[row] = (dv.X(), dv.Y(), dv.Z())
    return s, su, sv


def _reimport_face_count(step_text: str, tmp_path) -> int:
    """Round-trip the STEP text through STEPControl_Reader and count faces."""
    path = tmp_path / "reimport.step"
    path.write_text(step_text, encoding="utf-8")
    reader = STEPControl_Reader()
    assert reader.ReadFile(str(path)) == IFSelect_RetDone
    assert reader.TransferRoots() > 0
    shape = reader.OneShape()
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


_CARTESIAN_POINT = re.compile(r"CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^)]*)\)\s*\)")


def _cartesian_coords(step_text: str) -> np.ndarray:
    """All coordinate values of every CARTESIAN_POINT in the STEP text."""
    values: list[float] = []
    for group in _CARTESIAN_POINT.findall(step_text):
        values.extend(float(token) for token in group.split(","))
    assert values, "no CARTESIAN_POINT entities found in the STEP text"
    return np.array(values)


# --- fixture sanity: the degree-elevated cylinder is still EXACTLY on the cylinder ----------


def test_elevated_cylinder_fixture_is_exact():
    surface = cylinder_surface()
    s, _, sv = _mlx_eval(surface)
    np.testing.assert_allclose(s[:, 0] ** 2 + s[:, 1] ** 2, RADIUS**2, rtol=0.0, atol=1e-12)
    # z == v * HEIGHT exactly, dS/dv == (0, 0, HEIGHT) exactly (elevation preserved the line)
    v_vals = np.array([v for _, v in UV_PAIRS])
    np.testing.assert_allclose(s[:, 2], v_vals * HEIGHT, rtol=0.0, atol=1e-12)
    np.testing.assert_allclose(sv, np.broadcast_to([0.0, 0.0, HEIGHT], sv.shape), rtol=0.0, atol=1e-12)


# --- the headline: MLX-vs-OCCT D0/D1 parity on the compact-knot handoff ---------------------


@pytest.mark.parametrize("build", [wavy_surface, cylinder_surface], ids=["wavy", "cylinder"])
def test_d0_d1_parity_mlx_vs_occt(build):
    surface = build()
    occ_surf = build_bspline_surface(surface)
    s_mlx, su_mlx, sv_mlx = _mlx_eval(surface)
    s_occ, su_occ, sv_occ = _occt_eval(occ_surf)
    np.testing.assert_allclose(s_occ, s_mlx, rtol=0.0, atol=1e-9)
    np.testing.assert_allclose(su_occ, su_mlx, rtol=0.0, atol=1e-7)
    np.testing.assert_allclose(sv_occ, sv_mlx, rtol=0.0, atol=1e-7)


def test_build_bspline_surface_shape_flags():
    wavy = build_bspline_surface(wavy_surface())
    assert (wavy.NbUPoles(), wavy.NbVPoles()) == (NU, NV)  # rows = u — the orientation contract
    assert (wavy.UDegree(), wavy.VDegree()) == (P_U, Q_V)
    assert not wavy.IsUPeriodic() and not wavy.IsVPeriodic()
    assert not (wavy.IsURational() or wavy.IsVRational())
    cyl = build_bspline_surface(cylinder_surface())
    # The weights land in the right slots: Weight(i, j) is 1-based with i = u row,
    # so the √2/2 mid-arc weight sits at u-row 2. NOTE OCCT's Is[UV]Rational flag
    # convention is crossed relative to the varying index (its internal Rational()
    # helper marks first-index weight variation as VRational) — assert the placed
    # weight and "rational at all", not a specific direction flag; the D0/D1
    # parity test is the real proof the weights are honored.
    assert math.isclose(cyl.Weight(2, 1), W_MID, rel_tol=0.0, abs_tol=1e-15)
    assert cyl.IsURational() or cyl.IsVRational()


# --- STEP round-trip -------------------------------------------------------------------------


def test_step_single_surface_roundtrip(tmp_path):
    step_text, faces = surfaces_to_step([wavy_surface()])
    assert faces == 1
    assert step_text.strip()
    assert "B_SPLINE_SURFACE_WITH_KNOTS" in step_text
    assert _reimport_face_count(step_text, tmp_path) == 1


def test_step_two_surfaces_roundtrip(tmp_path):
    step_text, faces = surfaces_to_step([wavy_surface(), cylinder_surface()])
    assert faces == 2
    assert "B_SPLINE_SURFACE_WITH_KNOTS" in step_text
    assert _reimport_face_count(step_text, tmp_path) == 2


def test_rational_surface_emits_rational_step_form():
    step_text, faces = surfaces_to_step([cylinder_surface()])
    assert faces == 1
    # OCCT writes a rational B-spline as the complex-entity form
    assert "RATIONAL_B_SPLINE_SURFACE" in step_text
    assert "B_SPLINE_SURFACE_WITH_KNOTS" in step_text


def test_surfaces_to_step_accepts_surfaces_container():
    container = Surfaces(surfaces=[wavy_surface()])
    from_container = surfaces_to_step(container)
    from_list = surfaces_to_step([wavy_surface()])
    assert from_container[1] == from_list[1] == 1
    assert _data_section(from_container[0]) == _data_section(from_list[0])


def test_surfaces_to_step_rejects_empty_surface_list():
    with pytest.raises(ValueError, match="requires at least one surface"):
        surfaces_to_step([])


# --- units: STEP is written in MILLIMETRES (FablesFindings I1) -------------------------------
#
# This previously asserted the OPPOSITE — that coordinates stayed raw metres and
# "nothing was scaled (a mm conversion would put 1500.0 in the text)". That
# pinned the defect as the contract: OCCT writes raw numbers but DECLARES the
# file millimetre, so a 1.5 m radius went out as "1.5 mm" — 1000x too small for
# every consumer. It looked fine only because Plastiq's reader was wrong the same
# way. Both sides now convert at the boundary, so the file is honest.


def test_step_coordinates_are_millimetres():
    step_text, _ = surfaces_to_step([cylinder_surface()])
    coords = _cartesian_coords(step_text)
    # The poles are converted m → mm: RADIUS 1.5 m → 1500 mm, HEIGHT 2.0 m → 2000 mm.
    assert np.isclose(coords, RADIUS * 1000.0, rtol=0.0, atol=1e-6).any()
    assert np.isclose(coords, HEIGHT * 1000.0, rtol=0.0, atol=1e-6).any()
    # The raw SI magnitudes must NOT appear as coordinates any more.
    assert np.abs(coords).max() > 100.0


def test_step_declares_the_millimetre_unit_it_writes():
    # The scale is only correct if the file also DECLARES millimetre — the two
    # must agree, and it is their disagreement that was the 1000x defect.
    step_text, _ = surfaces_to_step([cylinder_surface()])
    assert re.search(r"LENGTH_UNIT\(\)[\s\S]{0,60}SI_UNIT\(\.MILLI\.,\.METRE\.\)", step_text)


# --- validation happens BEFORE OCCT / before any subprocess (§6.2, FR-6) ---------------------


def _knot_law_breaking_payload() -> dict:
    """A §6.2 invariant-2 violation: sum(u_mults) != num_poles_u + u_degree + 1.

    Ends stay clamped and the interior mult stays within 1..degree, so the ONLY
    broken invariant is the knot-count law — the payload that would blow up inside
    the Geom_BSplineSurface constructor if it ever reached OCCT.
    """
    payload = wavy_surface().model_dump()
    payload["u_mults"] = [3, 1, 2, 3]  # sum 9 != NU + P_U + 1 == 8
    return {"surfaces": [payload]}


def test_invalid_payload_raises_validation_error_without_spawning(monkeypatch):
    spawned = []

    def _no_spawn(*args, **kwargs):  # pragma: no cover - must never run
        spawned.append(args)
        raise AssertionError("run_isolated must not be called for a schema-invalid payload")

    monkeypatch.setattr(occ_step, "run_isolated", _no_spawn)
    with pytest.raises(ValidationError, match="knot-count law"):
        surfaces_json_to_step(_knot_law_breaking_payload())
    assert spawned == []


def test_step_worker_validates_too():
    # belt and braces: the worker re-validates inside the subprocess as well
    with pytest.raises(ValidationError, match="knot-count law"):
        step_worker(_knot_law_breaking_payload())


# --- the isolated path returns exactly what the direct path returns --------------------------


# OCCT bakes per-process transfer counters into two DATA entities: the PRODUCT
# name ("Open CASCADE STEP translator 7.9 <n>") and the NEXT_ASSEMBLY_USAGE_
# OCCURRENCE id. Byte-identity across conversions holds only after normalizing
# them. Everything geometric must still match exactly.
_PRODUCT_COUNTER = re.compile(r"(Open CASCADE STEP translator [0-9.]+) \d+")
_NAUO_COUNTER = re.compile(r"(NEXT_ASSEMBLY_USAGE_OCCURRENCE\(')\d+(')")


def _data_section(step_text: str) -> str:
    """The STEP DATA section, normalized for comparison.

    The header is excluded (FILE_NAME carries a timestamp + the temp filename) and
    OCCT's per-process transfer counters (PRODUCT name, NAUO id) are canonicalized.
    """
    assert "DATA;" in step_text
    data = _PRODUCT_COUNTER.sub(r"\1 N", step_text.split("DATA;", 1)[1])
    return _NAUO_COUNTER.sub(r"\g<1>N\g<2>", data)


def test_step_worker_matches_direct_conversion():
    payload = {"surfaces": [wavy_surface().model_dump(), cylinder_surface().model_dump()]}
    result = step_worker(payload)
    assert set(result) == {"step", "faces"}
    direct_text, direct_faces = surfaces_to_step(Surfaces.model_validate(payload))
    assert result["faces"] == direct_faces == 2
    assert _data_section(result["step"]) == _data_section(direct_text)


def test_isolated_path_matches_direct_conversion(tmp_path):
    payload = {"surfaces": [wavy_surface().model_dump(), cylinder_surface().model_dump()]}
    iso_text, iso_faces = surfaces_json_to_step(payload, timeout=120.0)
    direct_text, direct_faces = surfaces_to_step(Surfaces.model_validate(payload))
    assert iso_faces == direct_faces == 2
    assert _data_section(iso_text) == _data_section(direct_text)
    assert _reimport_face_count(iso_text, tmp_path) == 2


# --- the honest-failure branch of surfaces_to_solid_step (never fabricate a solid) -----------
#
# The service's most safety-critical property: surfaces_to_solid_step must NEVER report
# is_solid=True for a surface set that does not sew into a single watertight shell. Its
# is_solid=False paths — _single_shell returning None on a compound of disjoint patches, and
# free_edges > 0 on an open shell — are exercised here on occ_step's OWN pure-NURBS caller.
# (test_faceted / test_pipeline_closed reach the SAME shared closure chain,
# occ_step.assemble_verified_solid, through faceted.py's separate caller.)


def test_solid_step_disjoint_patches_never_fabricates_solid(tmp_path):
    """Two disjoint patches cannot sew into one shell → honest is_solid=False (compound path).

    wavy and cylinder share no coincident edges, so BRepBuilderAPI_Sewing leaves them a compound
    (more than one shell / loose faces); _single_shell returns None, no solid is built, and the
    report says so honestly: is_solid False, free_edges > 0, volume 0.0. The STEP still serializes
    the (open) sewn shape and re-imports without crashing — a failed gate emits inspectable
    geometry, never a fabricated solid.
    """
    result = surfaces_to_solid_step([wavy_surface(), cylinder_surface()])
    assert set(result) == {"step", "faces", "is_solid", "is_valid", "free_edges", "volume"}
    assert result["is_solid"] is False, "disjoint patches must never be reported as a solid"
    assert result["free_edges"] > 0, "an unclosed surface set must report free (naked) edges"
    assert result["volume"] == 0.0, "no solid was built ⇒ no volume may be claimed"
    assert result["step"].strip(), "a failed gate must still emit inspectable STEP geometry"
    assert _reimport_face_count(result["step"], tmp_path) == 2  # both faces survive the round-trip


def test_solid_step_single_open_patch_is_not_a_solid(tmp_path):
    """A single open patch (one face, four naked edges) is an open shell, never a solid.

    free_edges > 0, so is_solid stays False even if MakeSolid accepts the open shell — the
    "serializes the solid even when the shell is open" nuance. The STEP re-imports without
    crashing.
    """
    result = surfaces_to_solid_step([wavy_surface()])
    assert result["is_solid"] is False, "a single open patch must never be reported as a solid"
    assert result["free_edges"] > 0
    assert result["step"].strip()
    assert _reimport_face_count(result["step"], tmp_path) >= 1
