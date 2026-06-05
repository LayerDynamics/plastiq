// R5 — first-party 3D mate solver (pure TS, no wasm).

import { describe, expect, it } from "vitest";

import { solveMates, type ComponentPose, type Mate } from "./solver.js";

const IDENT = (): [number, number, number, number] => [0, 0, 0, 1];

function comp(pos: [number, number, number], fixed = false): ComponentPose {
  return { position: pos, orientation: IDENT(), fixed };
}

describe("solveMates", () => {
  it("coincident snaps a free component's point onto a fixed one", () => {
    const comps = [comp([0, 0, 0], true), comp([0.1, 0.05, 0.02], false)];
    const mates: Mate[] = [
      { kind: "coincident", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] } },
    ];
    const r = solveMates(comps, mates);
    expect(r.poses[1]!.position[0]).toBeCloseTo(0, 6);
    expect(r.poses[1]!.position[1]).toBeCloseTo(0, 6);
    expect(r.poses[1]!.position[2]).toBeCloseTo(0, 6);
  });

  it("coincident with offset local points aligns those points in world", () => {
    const comps = [comp([0, 0, 0], true), comp([0.2, 0, 0], false)];
    const mates: Mate[] = [
      {
        kind: "coincident",
        a: { component: 0, point: [0.05, 0, 0] },
        b: { component: 1, point: [-0.05, 0, 0] },
      },
    ];
    const r = solveMates(comps, mates);
    // B's local (-0.05,0,0) must land on A's world (0.05,0,0) → B at (0.10,0,0).
    expect(r.poses[1]!.position[0]).toBeCloseTo(0.1, 5);
  });

  it("distance drives the gap between two component origins", () => {
    const comps = [comp([0, 0, 0], true), comp([0.03, 0, 0], false)];
    const mates: Mate[] = [
      { kind: "distance", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] }, value: 0.1 },
    ];
    const r = solveMates(comps, mates);
    const d = Math.hypot(...r.poses[1]!.position);
    expect(d).toBeCloseTo(0.1, 5);
  });

  it("parallel aligns a free component's axis with a fixed reference", () => {
    const comps = [comp([0, 0, 0], true), comp([0.1, 0, 0], false)];
    const mates: Mate[] = [
      { kind: "parallel", a: { component: 0, dir: [1, 0, 0] }, b: { component: 1, dir: [0, 0, 1] } },
    ];
    const r = solveMates(comps, mates);
    // After solve, B's rotated +Z axis should be parallel to A's +X.
    const q = r.poses[1]!.orientation;
    // Rotate [0,0,1] by q and check it's ±[1,0,0].
    const [x, y, z, w] = q;
    const rz: [number, number, number] = [
      2 * (x * z + w * y),
      2 * (y * z - w * x),
      1 - 2 * (x * x + y * y),
    ];
    expect(Math.abs(rz[0])).toBeCloseTo(1, 4);
    expect(rz[1]).toBeCloseTo(0, 4);
    expect(rz[2]).toBeCloseTo(0, 4);
  });

  it("reports verdicts and DOF", () => {
    // No mates, one free component → 6 DOF, under-constrained.
    const free = solveMates([comp([0, 0, 0], true), comp([0.1, 0, 0], false)], []);
    expect(free.freedom).toBe(6);
    expect(free.verdict).toBe("under-constrained");

    // Coincident removes 3 translational DOF → 3 left, still under-constrained.
    const coinc = solveMates(
      [comp([0, 0, 0], true), comp([0.1, 0, 0], false)],
      [{ kind: "coincident", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] } }],
    );
    expect(coinc.freedom).toBe(3);
    expect(coinc.verdict).toBe("under-constrained");

    // All fixed → 0 DOF, well-constrained.
    const locked = solveMates([comp([0, 0, 0], true), comp([0.1, 0, 0], true)], []);
    expect(locked.freedom).toBe(0);
    expect(locked.verdict).toBe("well-constrained");
  });

  it("flags conflicting distances as over-constrained", () => {
    const comps = [comp([0, 0, 0], true), comp([0.05, 0, 0], false)];
    const mates: Mate[] = [
      { kind: "distance", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] }, value: 0.1 },
      { kind: "distance", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] }, value: 0.2 },
    ];
    const r = solveMates(comps, mates);
    expect(r.verdict).toBe("over-constrained");
  });
});
