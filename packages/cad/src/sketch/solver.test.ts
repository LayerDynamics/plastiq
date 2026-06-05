// R5 — sketch constraint solver, exercised against the real planegcs wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initSketchSolver, solveSketch, type Constraint, type SolverPoint } from "./solver.js";

beforeAll(async () => {
  await initSketchSolver();
}, 120_000);

describe("geometric constraints", () => {
  it("coincident snaps two points together", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0 },
      { x: 0.01, y: 0.01 },
    ];
    const r = solveSketch(pts, [], [{ kind: "coincident", a: 0, b: 1 }]);
    expect(r.points[0]!.x).toBeCloseTo(r.points[1]!.x, 6);
    expect(r.points[0]!.y).toBeCloseTo(r.points[1]!.y, 6);
  });

  it("distance drives the separation of a free point from a fixed one", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.01, y: 0, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "distance", a: 0, b: 1, value: 0.05 }]);
    const d = Math.hypot(r.points[1]!.x - r.points[0]!.x, r.points[1]!.y - r.points[0]!.y);
    expect(d).toBeCloseTo(0.05, 6);
  });

  it("horizontal makes two points share a y", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.05, y: 0.02, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "horizontal", a: 0, b: 1 }]);
    expect(r.points[1]!.y).toBeCloseTo(0, 6);
  });

  it("hDistance constrains only the x-separation", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.01, y: 0.03, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "hDistance", a: 0, b: 1, value: 0.04 }]);
    expect(r.points[1]!.x - r.points[0]!.x).toBeCloseTo(0.04, 6);
  });

  it("radius drives a circle's radius", () => {
    const pts: SolverPoint[] = [{ x: 0, y: 0, fixed: true }];
    const r = solveSketch(pts, [{ center: 0, radius: 0.01 }], [
      { kind: "radius", circle: 0, value: 0.03 },
    ]);
    expect(r.radii[0]).toBeCloseTo(0.03, 6);
  });

  it("midpoint places a point at the centre of a segment", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.06, y: 0, fixed: true },
      { x: 0.01, y: 0.02, fixed: false },
    ];
    const r = solveSketch(pts, [], [{ kind: "midpoint", m: 2, a: 0, b: 1 }]);
    expect(r.points[2]!.x).toBeCloseTo(0.03, 6);
    expect(r.points[2]!.y).toBeCloseTo(0, 6);
  });
});

describe("verdict + degrees of freedom", () => {
  it("reports under-constrained with free DOF", () => {
    const r = solveSketch([{ x: 0, y: 0 }, { x: 0.05, y: 0 }], [], []);
    expect(r.freedom).toBeGreaterThan(0);
    expect(r.verdict).toBe("under-constrained");
  });

  it("reports well-constrained at zero DOF", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.05, y: 0, fixed: false },
    ];
    const cons: Constraint[] = [
      { kind: "distance", a: 0, b: 1, value: 0.05 },
      { kind: "horizontal", a: 0, b: 1 },
    ];
    const r = solveSketch(pts, [], cons);
    expect(r.freedom).toBe(0);
    expect(r.verdict).toBe("well-constrained");
  });

  it("reports over-constrained on conflicting dimensions", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.05, y: 0, fixed: false },
    ];
    const cons: Constraint[] = [
      { kind: "distance", a: 0, b: 1, value: 0.05 },
      { kind: "distance", a: 0, b: 1, value: 0.03 },
    ];
    const r = solveSketch(pts, [], cons);
    expect(r.verdict).toBe("over-constrained");
  });
});
