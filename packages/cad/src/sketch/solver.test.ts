import { describe, expect, it } from "vitest";
import { solveSketch, type Constraint, type SolverCircle, type SolverPoint } from "./solver.js";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

function solve(points: SolverPoint[], constraints: Constraint[], circles: SolverCircle[] = []) {
  return solveSketch(points, circles, constraints);
}

describe("2D constraint solver — geometric constraints (FR-2)", () => {
  it("coincident pulls a free point onto a fixed one", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 5, y: 3 },
      ],
      [{ kind: "coincident", a: 0, b: 1 }],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    expect(dist(r.points[0]!, r.points[1]!)).toBeLessThan(1e-7);
  });

  it("distance sets the separation to the target", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 1, y: 1 },
      ],
      [{ kind: "distance", a: 0, b: 1, value: 5 }],
    );
    expect(dist(r.points[0]!, r.points[1]!)).toBeCloseTo(5, 7);
  });

  it("horizontal / vertical align a segment", () => {
    const h = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 3, y: 4 },
      ],
      [{ kind: "horizontal", a: 0, b: 1 }],
    );
    expect(h.points[1]!.y).toBeCloseTo(0, 7);
    const v = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 3, y: 4 },
      ],
      [{ kind: "vertical", a: 0, b: 1 }],
    );
    expect(v.points[1]!.x).toBeCloseTo(0, 7);
  });

  it("perpendicular drives the dot product of two segment directions to zero", () => {
    // line0: (0,0)->(1,0) fixed horizontal; line1: (0,0)->free, made ⟂.
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 1, y: 0, fixed: true },
        { x: 0, y: 0, fixed: true },
        { x: 2, y: 0.3 },
      ],
      [{ kind: "perpendicular", a: 2, b: 3, c: 0, d: 1 }],
    );
    const u = { x: r.points[3]!.x - r.points[2]!.x, y: r.points[3]!.y - r.points[2]!.y };
    expect(Math.abs(u.x * 1 + u.y * 0)).toBeLessThan(1e-6); // u · (1,0) ≈ 0 → vertical
  });

  it("parallel drives the cross product to zero", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 1, y: 0, fixed: true },
        { x: 0, y: 1, fixed: true },
        { x: 2, y: 1.5 },
      ],
      [{ kind: "parallel", a: 2, b: 3, c: 0, d: 1 }],
    );
    const u = { x: r.points[3]!.x - r.points[2]!.x, y: r.points[3]!.y - r.points[2]!.y };
    expect(Math.abs(u.x * 0 - u.y * 1)).toBeLessThan(1e-6); // cross with (1,0) ≈ 0 → horizontal
  });

  it("equalLength makes two segments the same length", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 4, y: 0, fixed: true }, // line0 length 4
        { x: 0, y: 0, fixed: true },
        { x: 1, y: 0 }, // free → length grows to 4
      ],
      [{ kind: "equalLength", a: 0, b: 1, c: 2, d: 3 }],
    );
    expect(dist(r.points[2]!, r.points[3]!)).toBeCloseTo(4, 6);
  });

  it("angle of π/2 makes two segments perpendicular", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 1, y: 0, fixed: true },
        { x: 0, y: 0, fixed: true },
        { x: 1, y: 0.2 },
      ],
      [{ kind: "angle", a: 0, b: 1, c: 2, d: 3, value: Math.PI / 2 }],
    );
    const v = { x: r.points[3]!.x - r.points[2]!.x, y: r.points[3]!.y - r.points[2]!.y };
    expect(Math.abs(v.x)).toBeLessThan(1e-5); // ⟂ to (1,0)
  });
});

describe("2D constraint solver — circle constraints", () => {
  it("radius pins a circle radius", () => {
    const r = solve(
      [{ x: 0, y: 0, fixed: true }],
      [{ kind: "radius", circle: 0, value: 2.5 }],
      [{ center: 0, radius: 1 }],
    );
    expect(r.radii[0]).toBeCloseTo(2.5, 9);
  });

  it("concentric makes two centres coincident", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 3, y: 4 },
      ],
      [{ kind: "concentric", a: 0, b: 1 }],
    );
    expect(dist(r.points[0]!, r.points[1]!)).toBeLessThan(1e-7);
  });

  it("equalRadius equalizes two circle radii", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 5, y: 0, fixed: true },
      ],
      [{ kind: "equalRadius", a: 0, b: 1 }],
      [
        { center: 0, radius: 1, fixed: true },
        { center: 1, radius: 9 },
      ],
    );
    expect(r.radii[1]).toBeCloseTo(1, 7);
  });

  it("tangentLineCircle sets the centre-to-line distance to the radius", () => {
    // Horizontal line on y=0; circle centre free in y, radius 2 fixed → centre.y → 2.
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 10, y: 0, fixed: true },
        { x: 5, y: 5 },
      ],
      [{ kind: "tangentLineCircle", a: 0, b: 1, circle: 0 }],
      [{ center: 2, radius: 2, fixed: true }],
    );
    expect(Math.abs(r.points[2]!.y)).toBeCloseTo(2, 6);
  });
});

describe("2D constraint solver — point-on-object / symmetric / midpoint (D8)", () => {
  it("midpoint pins a free point to the centre of a fixed segment", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 10, y: 4, fixed: true },
        { x: 9, y: 9 }, // free → should land at (5,2)
      ],
      [{ kind: "midpoint", m: 2, a: 0, b: 1 }],
    );
    expect(r.points[2]!.x).toBeCloseTo(5, 6);
    expect(r.points[2]!.y).toBeCloseTo(2, 6);
  });

  it("pointOnLine pulls a free point onto a fixed line", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 10, y: 0, fixed: true },
        { x: 5, y: 3 }, // free in y → onto y=0; x stays (1 residual, under-constrained)
      ],
      [{ kind: "pointOnLine", p: 2, a: 0, b: 1 }],
    );
    expect(r.points[2]!.y).toBeCloseTo(0, 6);
  });

  it("pointOnCircle pulls a free point onto a fixed circle", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true }, // centre
        { x: 5, y: 5 }, // free → onto radius-3 circle
      ],
      [{ kind: "pointOnCircle", p: 1, circle: 0 }],
      [{ center: 0, radius: 3, fixed: true }],
    );
    expect(dist(r.points[1]!, r.points[0]!)).toBeCloseTo(3, 6);
  });

  it("hDistance / vDistance pin the signed axis separation", () => {
    const rh = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 0.01, y: 0.05 }, // free → Δx must become 0.04
      ],
      [{ kind: "hDistance", a: 0, b: 1, value: 0.04 }],
    );
    expect(rh.points[1]!.x - rh.points[0]!.x).toBeCloseTo(0.04, 6);
    const rv = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 0.05, y: 0.01 }, // free → Δy must become 0.04
      ],
      [{ kind: "vDistance", a: 0, b: 1, value: 0.04 }],
    );
    expect(rv.points[1]!.y - rv.points[0]!.y).toBeCloseTo(0.04, 6);
  });

  it("symmetric mirrors a free point across a fixed axis", () => {
    // Axis = the x-line (0,0)→(10,0). A fixed at (3,2); B free → its mirror (3,-2).
    const r = solve(
      [
        { x: 0, y: 0, fixed: true }, // axis c
        { x: 10, y: 0, fixed: true }, // axis d
        { x: 3, y: 2, fixed: true }, // a
        { x: 8, y: 8 }, // b, free
      ],
      [{ kind: "symmetric", a: 2, b: 3, c: 0, d: 1 }],
    );
    expect(r.points[3]!.x).toBeCloseTo(3, 6);
    expect(r.points[3]!.y).toBeCloseTo(-2, 6);
  });
});

describe("2D constraint solver — DOF verdicts", () => {
  it("well-constrained: a point fixed by two distances to two anchors", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 10, y: 0, fixed: true },
        { x: 5, y: 3 },
      ],
      [
        { kind: "distance", a: 0, b: 2, value: 6 },
        { kind: "distance", a: 1, b: 2, value: 6 },
      ],
    );
    expect(r.verdict).toBe("well-constrained");
    expect(r.freedom).toBe(0);
  });

  it("under-constrained: a free point with no constraints (2 DOF)", () => {
    const r = solve([{ x: 1, y: 2 }], []);
    expect(r.verdict).toBe("under-constrained");
    expect(r.freedom).toBe(2);
  });

  it("over-constrained (conflicting): two incompatible distances to one anchor", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 1, y: 1 },
      ],
      [
        { kind: "distance", a: 0, b: 1, value: 5 },
        { kind: "distance", a: 0, b: 1, value: 6 },
      ],
    );
    expect(r.verdict).toBe("over-constrained");
    expect(r.residualNorm).toBeGreaterThan(1e-3);
  });

  it("over-constrained (redundant but consistent): a duplicate distance on a pinned point", () => {
    const r = solve(
      [
        { x: 0, y: 0, fixed: true },
        { x: 10, y: 0, fixed: true },
        { x: 5, y: 3 },
      ],
      [
        { kind: "distance", a: 0, b: 2, value: 6 },
        { kind: "distance", a: 1, b: 2, value: 6 },
        { kind: "distance", a: 0, b: 2, value: 6 }, // duplicate of the first → redundant, consistent
      ],
    );
    // 3 equations, 2 DOF, rank 2, all consistent → solved but redundant.
    expect(r.residualNorm).toBeLessThan(1e-5);
    expect(r.verdict).toBe("over-constrained");
    expect(r.freedom).toBe(0);
  });
});
