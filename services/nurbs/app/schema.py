"""NURBS-surface JSON model + invariant validation (SPEC-12 §6.2, D-7/D-8, FR-6).

`NurbsSurface` is the wire model for one B-spline/NURBS surface and `Surfaces` is the
`{"surfaces": [...]}` result container. Every §6.2 invariant is enforced here, *before*
OCCT ever sees the data (FR-6) — a violation is a pydantic ``ValidationError`` with a
specific, distinguishable message, so it becomes a job ``failed``, never a native crash.

Knot-form convention (§6.2 invariant 5): the wire carries **compact** knots
(unique strictly-increasing values in ``u_knots``/``v_knots`` with parallel
multiplicities in ``u_mults``/``v_mults`` — the OCCT/NURBGen form). The core computes
on **flat** (textbook/geomdl) vectors; ``core/knots.py`` owns the array-level
conversion at that boundary. :meth:`NurbsSurface.flat_u_knots` /
:meth:`NurbsSurface.flat_v_knots` are the schema-level reference expansion.
"""

import math

from pydantic import BaseModel, Field, model_validator

# Export degree bounds (§6.2 invariant 4, D-8): OCCT's hard ceiling is 25, but CAD
# interop favors ≤ 8 (GeomAPI_PointsToBSplineSurface's own DegMax default). This module
# IS the export gate, so the bound lives here.
MIN_DEGREE = 2
MAX_DEGREE = 8


class NurbsSurface(BaseModel):
    """One validated NURBS surface (NURBGen-shaped fields, §6.2).

    Defaults follow SPEC-12 D-8: non-rational (``weights == []`` ⇒ all weights 1.0)
    and non-periodic. **Periodic surfaces are not supported in v1** — any surface with
    ``u_periodic`` or ``v_periodic`` set to ``True`` is rejected with a clear error;
    v1 knot vectors are always clamped (end multiplicity == degree + 1).

    Enforced invariants (§6.2):

    1. ``len(u_knots) == len(u_mults) >= 2`` and knots strictly increasing (likewise v).
    2. Non-periodic knot-count law ``sum(mults) == num_poles + degree + 1``; clamped
       ends (``mult == degree + 1``); interior multiplicities in ``1..degree``.
    3. ``poles`` rectangular ``num_u × num_v`` of 3-float points; ``weights`` either
       ``[]`` or the same-shaped grid with every value > 0.
    4. ``2 <= degree <= 8`` (the export bound).
    5. All numeric values finite (NaN/inf rejected in poles, weights, and knots).
    """

    poles: list[list[list[float]]] = Field(
        description="num_u × num_v grid of [x, y, z] control points, metres."
    )
    weights: list[list[float]] = Field(
        default_factory=list,
        description="[] ⇒ non-rational (all 1.0); else num_u × num_v grid, all > 0.",
    )
    u_knots: list[float] = Field(description="Compact form: unique values, strictly increasing.")
    v_knots: list[float] = Field(description="Compact form: unique values, strictly increasing.")
    u_mults: list[int] = Field(description="Per-knot multiplicities, parallel to u_knots.")
    v_mults: list[int] = Field(description="Per-knot multiplicities, parallel to v_knots.")
    u_degree: int
    v_degree: int
    u_periodic: bool = False
    v_periodic: bool = False

    # -- helpers ------------------------------------------------------------------

    @property
    def num_poles_u(self) -> int:
        """Number of control-point rows (the u direction)."""
        return len(self.poles)

    @property
    def num_poles_v(self) -> int:
        """Number of control-point columns (the v direction)."""
        return len(self.poles[0]) if self.poles else 0

    @property
    def is_rational(self) -> bool:
        """True when an explicit weights grid is present (§6.2: ``[]`` ⇒ non-rational)."""
        return len(self.weights) > 0

    def flat_u_knots(self) -> list[float]:
        """Expanded textbook-form u knot vector (each value repeated by its multiplicity)."""
        return _flatten(self.u_knots, self.u_mults)

    def flat_v_knots(self) -> list[float]:
        """Expanded textbook-form v knot vector (each value repeated by its multiplicity)."""
        return _flatten(self.v_knots, self.v_mults)

    # -- invariants ---------------------------------------------------------------

    @model_validator(mode="after")
    def _validate_invariants(self) -> "NurbsSurface":
        # Invariant 4 first: the degree bound is the export gate.
        _check_degree("u", self.u_degree)
        _check_degree("v", self.v_degree)

        # v1 scope (D-8): non-periodic only.
        _check_non_periodic("u", self.u_periodic)
        _check_non_periodic("v", self.v_periodic)

        # Invariant 3: rectangular poles of finite 3D points, then the weights grid.
        _check_poles(self.poles)
        _check_weights(self.weights, self.num_poles_u, self.num_poles_v)

        # Invariants 1 + 2 per direction (lengths, monotonicity, clamping, mult
        # ranges, knot-count law).
        _check_direction("u", self.u_knots, self.u_mults, self.u_degree, self.num_poles_u)
        _check_direction("v", self.v_knots, self.v_mults, self.v_degree, self.num_poles_v)
        return self


class Surfaces(BaseModel):
    """The ``{"surfaces": [...]}`` result container (§6.2, carried in results per FR-6)."""

    surfaces: list[NurbsSurface]


# -- module-level checks (specific, distinguishable error messages) ------------------


def _flatten(knots: list[float], mults: list[int]) -> list[float]:
    flat: list[float] = []
    for knot, mult in zip(knots, mults):
        flat.extend([knot] * mult)
    return flat


def _check_degree(axis: str, degree: int) -> None:
    if not MIN_DEGREE <= degree <= MAX_DEGREE:
        raise ValueError(
            f"{axis}_degree must be within the v1 export bounds "
            f"{MIN_DEGREE}..{MAX_DEGREE} (got {degree})"
        )


def _check_non_periodic(axis: str, periodic: bool) -> None:
    if periodic:
        raise ValueError(
            f"periodic surfaces are not supported in v1 ({axis}_periodic must be false)"
        )


def _check_poles(poles: list[list[list[float]]]) -> None:
    if not poles or not poles[0]:
        raise ValueError("poles must be a non-empty num_u x num_v grid")
    num_v = len(poles[0])
    for i, row in enumerate(poles):
        if len(row) != num_v:
            raise ValueError(
                f"poles must be rectangular: row {i} has {len(row)} columns, expected {num_v}"
            )
        for j, point in enumerate(row):
            if len(point) != 3:
                raise ValueError(
                    f"poles[{i}][{j}] must be a 3D point [x, y, z] (got {len(point)} values)"
                )
            if not all(math.isfinite(c) for c in point):
                raise ValueError(f"poles[{i}][{j}] contains a non-finite value")


def _check_weights(weights: list[list[float]], num_u: int, num_v: int) -> None:
    if not weights:  # [] ⇒ non-rational (all weights 1.0)
        return
    if len(weights) != num_u:
        raise ValueError(
            f"weights grid must match the poles grid {num_u} x {num_v} "
            f"(got {len(weights)} rows)"
        )
    for i, row in enumerate(weights):
        if len(row) != num_v:
            raise ValueError(
                f"weights grid must match the poles grid {num_u} x {num_v} "
                f"(row {i} has {len(row)} values)"
            )
        for j, w in enumerate(row):
            if not math.isfinite(w):
                raise ValueError(f"weights[{i}][{j}] is not finite")
            if w <= 0.0:
                raise ValueError(f"weights must be strictly positive (weights[{i}][{j}] = {w})")


def _check_direction(
    axis: str, knots: list[float], mults: list[int], degree: int, num_poles: int
) -> None:
    # Invariant 1: parallel arrays, at least two unique knots, strictly increasing.
    if len(knots) != len(mults):
        raise ValueError(f"{axis}_knots length ({len(knots)}) != {axis}_mults length ({len(mults)})")
    if len(knots) < 2:
        raise ValueError(f"{axis}_knots must contain at least 2 knots (got {len(knots)})")
    for i, knot in enumerate(knots):
        if not math.isfinite(knot):
            raise ValueError(f"{axis}_knots[{i}] is not finite")
    for i in range(1, len(knots)):
        if knots[i] <= knots[i - 1]:
            raise ValueError(
                f"{axis}_knots must be strictly increasing "
                f"({axis}_knots at index {i} = {knots[i]} is not > {knots[i - 1]})"
            )

    # Invariant 2 (non-periodic): clamped ends, interior mult range, knot-count law.
    clamp = degree + 1
    if mults[0] != clamp or mults[-1] != clamp:
        raise ValueError(
            f"{axis} knot vector ends are not clamped: end multiplicities must equal "
            f"{axis}_degree + 1 = {clamp} (got first = {mults[0]}, last = {mults[-1]})"
        )
    for i, mult in enumerate(mults[1:-1], start=1):
        if not 1 <= mult <= degree:
            raise ValueError(
                f"{axis} interior multiplicity at index {i} must be in "
                f"1..{axis}_degree = {degree} (got {mult})"
            )
    expected = num_poles + degree + 1
    if sum(mults) != expected:
        raise ValueError(
            f"{axis} knot-count law violated: sum({axis}_mults) = {sum(mults)} != "
            f"num_poles_{axis} + {axis}_degree + 1 = {expected}"
        )
