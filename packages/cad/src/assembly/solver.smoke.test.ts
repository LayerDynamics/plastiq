// assembly/solver — SMOKE: solveMates runs on a simple mate set and returns a
// well-formed result. Convergence/verdict correctness is in solver.test.ts.

import { describe, expect, it } from "vitest";

import { type ComponentPose, type Mate, solveMates } from "./solver.js";

const VERDICTS = ["under-constrained", "well-constrained", "over-constrained", "did-not-converge"];

describe("solveMates — smoke", () => {
  it("solves a coincident mate and returns a well-formed result", () => {
    const comps: ComponentPose[] = [
      { position: [0, 0, 0], orientation: [0, 0, 0, 1], fixed: true },
      { position: [0.1, 0, 0], orientation: [0, 0, 0, 1] },
    ];
    const mates: Mate[] = [
      { kind: "coincident", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] } },
    ];
    const r = solveMates(comps, mates);
    expect(r.poses).toHaveLength(2);
    expect(r.poses[1]!.position.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(r.residualNorm)).toBe(true);
    expect(VERDICTS).toContain(r.verdict);
  });

  it("an empty mate set leaves a fixed component's pose unchanged", () => {
    const comps: ComponentPose[] = [{ position: [1, 2, 3], orientation: [0, 0, 0, 1], fixed: true }];
    const r = solveMates(comps, []);
    expect(r.poses[0]!.position).toEqual([1, 2, 3]);
  });
});
