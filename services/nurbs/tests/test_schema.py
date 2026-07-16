"""Tests for `app/schema.py` — SPEC-12 §6.2 NURBS-surface JSON invariants (task U2.3).

Valid-fixture matrix (degrees 2 and 3, non-rational and rational, single-span and
multi-interior-knot) plus one test per violated §6.2 invariant, each asserting the
specific error text. All data is deterministic and hand-written.
"""

import pytest
from pydantic import ValidationError

from app.schema import NurbsSurface, Surfaces


def make_poles(num_u: int, num_v: int) -> list[list[list[float]]]:
    """Deterministic rectangular num_u x num_v grid of [x, y, z] points."""
    return [[[float(i), float(j), 0.0] for j in range(num_v)] for i in range(num_u)]


def bicubic_4x4(**overrides) -> dict:
    """Minimal single-span bicubic: degree 3 needs degree+1 = 4 poles per direction."""
    data = {
        "poles": make_poles(4, 4),
        "weights": [],
        "u_knots": [0.0, 1.0],
        "v_knots": [0.0, 1.0],
        "u_mults": [4, 4],
        "v_mults": [4, 4],
        "u_degree": 3,
        "v_degree": 3,
        "u_periodic": False,
        "v_periodic": False,
    }
    data.update(overrides)
    return data


def biquadratic_3x3(**overrides) -> dict:
    """Minimal 3x3-pole surface: degree 2 (sum(mults) = 6 = 3 poles + 2 + 1)."""
    data = {
        "poles": make_poles(3, 3),
        "weights": [],
        "u_knots": [0.0, 1.0],
        "v_knots": [0.0, 1.0],
        "u_mults": [3, 3],
        "v_mults": [3, 3],
        "u_degree": 2,
        "v_degree": 2,
        "u_periodic": False,
        "v_periodic": False,
    }
    data.update(overrides)
    return data


# --------------------------------------------------------------------------------------
# Valid-fixture matrix
# --------------------------------------------------------------------------------------


def test_valid_minimal_biquadratic_3x3():
    s = NurbsSurface(**biquadratic_3x3())
    assert s.num_poles_u == 3
    assert s.num_poles_v == 3
    assert s.is_rational is False
    assert s.flat_u_knots() == [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]
    assert s.flat_v_knots() == [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]


def test_valid_minimal_bicubic_4x4():
    s = NurbsSurface(**bicubic_4x4())
    assert s.num_poles_u == 4
    assert s.num_poles_v == 4
    assert s.is_rational is False
    assert s.flat_u_knots() == [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]
    assert len(s.flat_u_knots()) == sum(s.u_mults)


def test_valid_rational_bicubic_4x4():
    weights = [
        [1.0, 1.0, 1.0, 1.0],
        [1.0, 1.0, 2.5, 1.0],
        [1.0, 1.0, 1.0, 1.0],
        [1.0, 1.0, 1.0, 1.0],
    ]
    s = NurbsSurface(**bicubic_4x4(weights=weights))
    assert s.is_rational is True
    assert s.weights[1][2] == 2.5


def test_valid_multi_interior_knots_degree3():
    # sum(u_mults) = 4+1+1+1+4 = 11 = num_poles_u + 3 + 1  ->  num_poles_u = 7
    s = NurbsSurface(
        **bicubic_4x4(
            poles=make_poles(7, 4),
            u_knots=[0.0, 0.25, 0.5, 0.75, 1.0],
            u_mults=[4, 1, 1, 1, 4],
        )
    )
    assert s.num_poles_u == 7
    assert s.num_poles_v == 4
    assert s.flat_u_knots() == [0.0, 0.0, 0.0, 0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 1.0, 1.0]
    assert len(s.flat_u_knots()) == sum(s.u_mults)


def test_valid_mixed_degree_interior_mult_equals_degree():
    # u: degree 2, interior mult 2 (== degree, allowed): sum = 3+2+3 = 8 -> num_poles_u = 5
    # v: degree 3 single span -> 4 poles
    s = NurbsSurface(
        **bicubic_4x4(
            poles=make_poles(5, 4),
            u_knots=[0.0, 0.5, 1.0],
            u_mults=[3, 2, 3],
            u_degree=2,
        )
    )
    assert s.num_poles_u == 5
    assert s.num_poles_v == 4
    assert s.flat_u_knots() == [0.0, 0.0, 0.0, 0.5, 0.5, 1.0, 1.0, 1.0]


def test_valid_surfaces_container():
    doc = Surfaces(surfaces=[bicubic_4x4(), biquadratic_3x3()])
    assert len(doc.surfaces) == 2
    assert doc.surfaces[0].u_degree == 3
    assert doc.surfaces[1].u_degree == 2


# --------------------------------------------------------------------------------------
# One test per violated invariant — each asserts the specific error text
# --------------------------------------------------------------------------------------


def reject(data: dict) -> str:
    with pytest.raises(ValidationError) as exc:
        NurbsSurface(**data)
    return str(exc.value)


def test_rejects_knot_mult_length_mismatch():
    msg = reject(bicubic_4x4(u_mults=[4, 1, 4]))
    assert "u_knots length (2) != u_mults length (3)" in msg


def test_rejects_non_increasing_knots():
    # 7x4-pole multi-span layout, but the knot at index 2 repeats the previous value.
    msg = reject(
        bicubic_4x4(
            poles=make_poles(7, 4),
            u_knots=[0.0, 0.25, 0.25, 0.75, 1.0],
            u_mults=[4, 1, 1, 1, 4],
        )
    )
    assert "u_knots must be strictly increasing" in msg
    assert "index 2" in msg


def test_rejects_knot_count_law_violation():
    # Clamped, valid mults — but 5 pole rows: sum(u_mults) = 8 != 5 + 3 + 1 = 9.
    msg = reject(bicubic_4x4(poles=make_poles(5, 4)))
    assert "u knot-count law violated: sum(u_mults) = 8 != num_poles_u + u_degree + 1 = 9" in msg


def test_rejects_unclamped_ends():
    # First mult 3 != degree + 1 = 4; pole count kept law-consistent (sum = 8 = 4+3+1).
    msg = reject(bicubic_4x4(u_knots=[0.0, 0.5, 1.0], u_mults=[3, 1, 4]))
    assert "u knot vector ends are not clamped" in msg
    assert "must equal u_degree + 1 = 4 (got first = 3, last = 4)" in msg


def test_rejects_interior_mult_above_degree():
    # Interior mult 4 > degree 3; pole count kept law-consistent (sum = 12 = 8+3+1).
    msg = reject(
        bicubic_4x4(
            poles=make_poles(8, 4),
            u_knots=[0.0, 0.5, 1.0],
            u_mults=[4, 4, 4],
        )
    )
    assert "u interior multiplicity at index 1 must be in 1..u_degree = 3 (got 4)" in msg


def test_rejects_ragged_poles():
    poles = make_poles(4, 4)
    poles[1] = poles[1][:3]  # row 1 loses a column
    msg = reject(bicubic_4x4(poles=poles))
    assert "poles must be rectangular: row 1 has 3 columns, expected 4" in msg


def test_rejects_wrong_arity_point():
    poles = make_poles(4, 4)
    poles[0][1] = [1.0, 2.0]  # 2 values, not [x, y, z]
    msg = reject(bicubic_4x4(poles=poles))
    assert "poles[0][1] must be a 3D point [x, y, z] (got 2 values)" in msg


def test_rejects_non_positive_weight():
    weights = [[1.0] * 4 for _ in range(4)]
    weights[0][1] = 0.0
    msg = reject(bicubic_4x4(weights=weights))
    assert "weights must be strictly positive (weights[0][1] = 0.0)" in msg


def test_rejects_weights_grid_shape_mismatch():
    weights = [[1.0] * 4 for _ in range(3)]  # 3 rows for a 4x4 pole grid
    msg = reject(bicubic_4x4(weights=weights))
    assert "weights grid must match the poles grid 4 x 4 (got 3 rows)" in msg


def test_rejects_degree_1():
    # Otherwise self-consistent degree-1 direction: sum = 2+2 = 4 = 2 poles + 1 + 1.
    msg = reject(
        bicubic_4x4(
            poles=make_poles(2, 4),
            u_mults=[2, 2],
            u_degree=1,
        )
    )
    assert "u_degree must be within the v1 export bounds 2..8 (got 1)" in msg


def test_rejects_degree_9():
    # Otherwise self-consistent degree-9 direction: sum = 10+10 = 20 = 10 poles + 9 + 1.
    msg = reject(
        bicubic_4x4(
            poles=make_poles(10, 4),
            u_mults=[10, 10],
            u_degree=9,
        )
    )
    assert "u_degree must be within the v1 export bounds 2..8 (got 9)" in msg


def test_rejects_periodic():
    msg = reject(bicubic_4x4(u_periodic=True))
    assert "periodic surfaces are not supported in v1 (u_periodic must be false)" in msg


def test_rejects_nan_pole():
    poles = make_poles(4, 4)
    poles[0][0] = [float("nan"), 0.0, 0.0]
    msg = reject(bicubic_4x4(poles=poles))
    assert "poles[0][0] contains a non-finite value" in msg


def test_rejects_empty_poles():
    msg = reject(bicubic_4x4(poles=[]))
    assert "poles must be a non-empty num_u x num_v grid" in msg


def test_rejects_ragged_weights_row():
    # Right number of rows (4) but row 1 is one column short — the per-ROW guard,
    # distinct from the row-COUNT mismatch already covered above.
    weights = [[1.0] * 4, [1.0] * 3, [1.0] * 4, [1.0] * 4]
    msg = reject(bicubic_4x4(weights=weights))
    assert "weights grid must match the poles grid 4 x 4 (row 1 has 3 values)" in msg


def test_rejects_non_finite_weight():
    weights = [[1.0] * 4 for _ in range(4)]
    weights[0][1] = float("nan")
    msg = reject(bicubic_4x4(weights=weights))
    assert "weights[0][1] is not finite" in msg


def test_rejects_fewer_than_two_knots():
    # Single knot (mults kept parallel so the length-equality check passes first).
    msg = reject(bicubic_4x4(u_knots=[0.0], u_mults=[8]))
    assert "u_knots must contain at least 2 knots (got 1)" in msg


def test_rejects_non_finite_knot():
    # inf at index 1: the finite-check loop runs before the strictly-increasing loop.
    msg = reject(bicubic_4x4(u_knots=[0.0, float("inf")], u_mults=[4, 4]))
    assert "u_knots[1] is not finite" in msg


def test_rejects_interior_mult_below_one():
    # Interior mult 0 (< 1) — the LOWER bound of the interior-multiplicity range.
    # sum = 8 = 4 poles + 3 + 1, ends clamped, so the ONLY violation is mult 0.
    msg = reject(bicubic_4x4(u_knots=[0.0, 0.5, 1.0], u_mults=[4, 0, 4]))
    assert "u interior multiplicity at index 1 must be in 1..u_degree = 3 (got 0)" in msg
