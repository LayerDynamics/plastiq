// sketch/solver — SMOKE (real planegcs wasm): initSketchSolver / sketchSolverReady /
// solveSketch all run and return well-formed results. Constraint-satisfaction
// correctness is in solver.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initSketchSolver, sketchSolverReady, solveSketch } from "./solver.js";

beforeAll(async () => {
  await initSketchSolver();
}, 120_000);

describe("sketch solver — smoke", () => {
  it("sketchSolverReady is true once initSketchSolver has run", () => {
    expect(sketchSolverReady()).toBe(true);
  });

  it("solveSketch runs on a constrained pair and returns a well-formed result", () => {
    const r = solveSketch([{ x: 0, y: 0 }, { x: 0.05, y: 0.01 }], [], [{ kind: "horizontal", a: 0, b: 1 }]);
    expect(r.points).toHaveLength(2);
    expect(typeof r.verdict).toBe("string");
    expect(Number.isFinite(r.freedom)).toBe(true);
  });

  it("an empty sketch is trivially well-constrained", () => {
    const r = solveSketch([], [], []);
    expect(r.points).toHaveLength(0);
    expect(r.verdict).toBe("well-constrained");
  });
});
