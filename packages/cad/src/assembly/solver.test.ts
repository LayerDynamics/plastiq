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

  it("reports converged=true for a satisfiable solve, false for a conflict (H4)", () => {
    // Satisfiable: a single coincident mate is solvable → the residual reaches 0.
    const ok = solveMates(
      [comp([0, 0, 0], true), comp([0.1, 0.05, 0.02], false)],
      [{ kind: "coincident", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] } }],
    );
    expect(ok.converged).toBe(true);
    expect(ok.residualNorm).toBeLessThan(1e-5);

    // Conflicting distances cannot both hold → NOT converged, and the residual is
    // at a least-squares minimum (gradient ≈ 0), so it's classified a genuine
    // conflict (over-constrained) — not mislabeled, and not silently 'satisfied'.
    const conflict = solveMates(
      [comp([0, 0, 0], true), comp([0.05, 0, 0], false)],
      [
        { kind: "distance", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] }, value: 0.1 },
        { kind: "distance", a: { component: 0, point: [0, 0, 0] }, b: { component: 1, point: [0, 0, 0] }, value: 0.2 },
      ],
    );
    expect(conflict.converged).toBe(false);
    expect(conflict.verdict).toBe("over-constrained");
    expect(conflict.residualNorm).toBeGreaterThan(1e-5);
  });

  it("a satisfiable empty/locked assembly is reported converged", () => {
    expect(solveMates([comp([0, 0, 0], true)], []).converged).toBe(true);
    expect(
      solveMates([comp([0, 0, 0], true), comp([0.1, 0, 0], false)], []).converged,
    ).toBe(true);
  });

  it("K9: an out-of-range component index returns an 'invalid' verdict, not a TypeError", () => {
    const comps = [comp([0, 0, 0], true), comp([0.1, 0, 0], false)];
    // component: 5 indexes past the 2-component array; residuals would read
    // poses[5] === undefined and throw deep in the solver without the guard.
    const mates: Mate[] = [
      { kind: "coincident", a: { component: 0, point: [0, 0, 0] }, b: { component: 5, point: [0, 0, 0] } },
    ];
    let r: ReturnType<typeof solveMates>;
    expect(() => {
      r = solveMates(comps, mates);
    }).not.toThrow();
    expect(r!.verdict).toBe("invalid");
    expect(r!.converged).toBe(false);
    expect(typeof r!.reason).toBe("string");
    expect(r!.reason!.length).toBeGreaterThan(0);
    // The input poses are echoed back untouched (nothing was solved).
    expect(r!.poses[1]!.position).toEqual([0.1, 0, 0]);
  });

  it("K9: the -1 sentinel (a failed id→index lookup) is refused gracefully", () => {
    const comps = [comp([0, 0, 0], true), comp([0.1, 0, 0], false)];
    const mates: Mate[] = [
      { kind: "coincident", a: { component: 0, point: [0, 0, 0] }, b: { component: -1, point: [0, 0, 0] } },
    ];
    const r = solveMates(comps, mates);
    expect(r.verdict).toBe("invalid");
    expect(r.converged).toBe(false);
  });
});
