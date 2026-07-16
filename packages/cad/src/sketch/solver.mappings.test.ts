// Direct tests for the sketch-constraint → planegcs mappings (solver.ts:140-223)
// that solver.test.ts does not cover: vertical, vDistance, parallel,
// perpendicular, equalLength, angle, concentric, tangentLineCircle, pointOnLine,
// pointOnCircle, symmetric. Each test drives the REAL planegcs wasm and asserts
// the solved geometry satisfies the constraint numerically — never just the
// verdict.

import { beforeAll, describe, expect, it } from "vitest";

import { initSketchSolver, solveSketch, type SolverPoint } from "./solver.js";

beforeAll(async () => {
  await initSketchSolver();
}, 120_000);

/** 2D cross product (z-component) of (b−a) × (d−c). */
function cross2(
  a: SolverPoint,
  b: SolverPoint,
  c: SolverPoint,
  d: SolverPoint,
): number {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = d.x - c.x;
  const vy = d.y - c.y;
  return ux * vy - uy * vx;
}

/** Dot product of the direction vectors (b−a)·(d−c). */
function dot2(a: SolverPoint, b: SolverPoint, c: SolverPoint, d: SolverPoint): number {
  return (b.x - a.x) * (d.x - c.x) + (b.y - a.y) * (d.y - c.y);
}

function len2(a: SolverPoint, b: SolverPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe("untested constraint mappings (real planegcs wasm)", () => {
  it("vertical makes two points share an x", () => {
    const pts: SolverPoint[] = [
      { x: 0.02, y: 0, fixed: true },
      { x: 0.035, y: 0.05, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "vertical", a: 0, b: 1 }]);
    expect(r.points[1]!.x).toBeCloseTo(0.02, 6);
  });

  it("vDistance constrains only the y-separation (b.y − a.y = value)", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.03, y: 0.01, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "vDistance", a: 0, b: 1, value: 0.04 }]);
    // Same signed convention the tested hDistance mapping uses: b − a = value.
    expect(r.points[1]!.y - r.points[0]!.y).toBeCloseTo(0.04, 6);
    // x is untouched by the constraint's residual once solved (1 eq on 2 DOF).
    expect(r.verdict).toBe("under-constrained");
  });

  it("parallel zeroes the cross product of two line directions", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.04, y: 0.03, fixed: true }, // reference line, direction (4,3)
      { x: 0.1, y: 0, fixed: true },
      { x: 0.15, y: 0.005, fixed: false }, // free end of the second line
    ];
    const r = solveSketch(pts, [], [{ kind: "parallel", a: 0, b: 1, c: 2, d: 3 }]);
    const p = r.points;
    const sinAngle =
      cross2(p[0]!, p[1]!, p[2]!, p[3]!) /
      (len2(p[0]!, p[1]!) * len2(p[2]!, p[3]!));
    expect(sinAngle).toBeCloseTo(0, 6);
  });

  it("perpendicular zeroes the dot product of two line directions", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.05, y: 0, fixed: true }, // reference line along +X
      { x: 0.02, y: 0.01, fixed: true },
      { x: 0.06, y: 0.03, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "perpendicular", a: 0, b: 1, c: 2, d: 3 }]);
    const p = r.points;
    const cosAngle =
      dot2(p[0]!, p[1]!, p[2]!, p[3]!) / (len2(p[0]!, p[1]!) * len2(p[2]!, p[3]!));
    expect(cosAngle).toBeCloseTo(0, 6);
    // Perpendicular to +X means the second line solved to vertical.
    expect(r.points[3]!.x).toBeCloseTo(0.02, 6);
  });

  it("equalLength drives the second line to the first line's length", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.05, y: 0, fixed: true }, // reference line, length 0.05
      { x: 0.1, y: 0, fixed: true },
      { x: 0.12, y: 0.01, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "equalLength", a: 0, b: 1, c: 2, d: 3 }]);
    expect(len2(r.points[2]!, r.points[3]!)).toBeCloseTo(0.05, 6);
  });

  it("angle drives the angle between two lines to the target (45°)", () => {
    // Line 1 fixed along +X; line 2 shares p0 and ends at a free point held at
    // 50mm by a distance dimension, so angle+distance fully fix it.
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.05, y: 0, fixed: true },
      { x: 0.04, y: 0.03, fixed: false }, // start near +37°, target +45°
    ];
    const r = solveSketch(
      pts,
      [],
      [
        { kind: "distance", a: 0, b: 2, value: 0.05 },
        { kind: "angle", a: 0, b: 1, c: 0, d: 2, value: Math.PI / 4 },
      ],
    );
    const p = r.points;
    const signed = Math.atan2(cross2(p[0]!, p[1]!, p[0]!, p[2]!), dot2(p[0]!, p[1]!, p[0]!, p[2]!));
    expect(signed).toBeCloseTo(Math.PI / 4, 5); // CCW from line 1 to line 2
    expect(len2(p[0]!, p[2]!)).toBeCloseTo(0.05, 6);
    expect(r.verdict).toBe("well-constrained");
  });

  it("concentric snaps one circle's centre onto the other's", () => {
    const pts: SolverPoint[] = [
      { x: 0.01, y: 0.02, fixed: true },
      { x: 0.03, y: 0.05, fixed: false },
    ];
    const circles = [
      { center: 0, radius: 0.02 },
      { center: 1, radius: 0.01 },
    ];
    // a/b are the centre POINT indices (see apps/plastiq sketch/model.ts, which
    // passes pointIndex(circle.center) for both sides).
    const r = solveSketch(pts, circles, [{ kind: "concentric", a: 0, b: 1 }]);
    expect(r.points[1]!.x).toBeCloseTo(0.01, 6);
    expect(r.points[1]!.y).toBeCloseTo(0.02, 6);
  });

  it("tangentLineCircle puts the (infinite) line at exactly one radius from the centre", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true }, // circle centre
      { x: -0.08, y: 0.06, fixed: true }, // line start
      { x: 0.08, y: 0.05, fixed: false }, // free line end
    ];
    const circles = [{ center: 0, radius: 0.03 }];
    const r = solveSketch(pts, circles, [
      // Pin the radius: it is a free solver parameter, so without this the
      // solver could satisfy tangency by inflating the circle instead.
      { kind: "radius", circle: 0, value: 0.03 },
      { kind: "tangentLineCircle", a: 1, b: 2, circle: 0 },
    ]);
    const p = r.points;
    // Perpendicular distance from the centre to the line through p1-p2.
    const dist =
      Math.abs(cross2(p[1]!, p[2]!, p[1]!, p[0]!)) / len2(p[1]!, p[2]!);
    expect(dist).toBeCloseTo(0.03, 6);
    expect(r.radii[0]).toBeCloseTo(0.03, 6);
  });

  it("pointOnLine makes the point collinear with the line's endpoints", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.08, y: 0.04, fixed: true },
      { x: 0.03, y: 0.03, fixed: false }, // starts off the line
    ];
    const r = solveSketch(pts, [], [{ kind: "pointOnLine", p: 2, a: 0, b: 1 }]);
    const p = r.points;
    const sinAngle =
      cross2(p[0]!, p[1]!, p[0]!, p[2]!) / (len2(p[0]!, p[1]!) * len2(p[0]!, p[2]!));
    expect(sinAngle).toBeCloseTo(0, 6);
  });

  it("pointOnCircle places the point at one radius from the centre", () => {
    const pts: SolverPoint[] = [
      { x: 0.01, y: 0, fixed: true }, // centre
      { x: 0.05, y: 0.02, fixed: false },
    ];
    const circles = [{ center: 0, radius: 0.025 }];
    const r = solveSketch(pts, circles, [
      { kind: "radius", circle: 0, value: 0.025 }, // pin the free radius param
      { kind: "pointOnCircle", p: 1, circle: 0 },
    ]);
    expect(len2(r.points[0]!, r.points[1]!)).toBeCloseTo(0.025, 6);
  });

  it("symmetric mirrors the free point across the axis line", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: -0.05, fixed: true }, // axis: the Y axis
      { x: 0, y: 0.05, fixed: true },
      { x: 0.03, y: 0.02, fixed: true }, // fixed side of the pair
      { x: -0.02, y: 0.03, fixed: false }, // free side, must land at (-0.03, 0.02)
    ];
    const r = solveSketch(pts, [], [{ kind: "symmetric", a: 2, b: 3, c: 0, d: 1 }]);
    expect(r.points[3]!.x).toBeCloseTo(-0.03, 6);
    expect(r.points[3]!.y).toBeCloseTo(0.02, 6);
    expect(r.verdict).toBe("well-constrained"); // 2 eqs pin the 2 free DOF
  });
});
