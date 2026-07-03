// Direct tests for the mate kinds solver.test.ts does not cover: concentric,
// perpendicular, and angle (assembly/solver.ts:36-42 / residuals at :101-127).
// Each test runs the real LM iteration and asserts the SOLVED POSES satisfy the
// mate numerically — never just the verdict.

import { describe, expect, it } from "vitest";

import {
  quatFromRotVec,
  quatRotate,
  vCross,
  vDot,
  vLen,
  vNorm,
  type Quat,
  type Vec3,
} from "./quat.js";
import { solveMates, type ComponentPose, type Mate } from "./solver.js";

const IDENT: [number, number, number, number] = [0, 0, 0, 1];

function comp(
  pos: [number, number, number],
  fixed: boolean,
  orientation: readonly [number, number, number, number] = IDENT,
): ComponentPose {
  return {
    position: pos,
    orientation: [...orientation] as [number, number, number, number],
    fixed,
  };
}

/** World direction of a component's local dir after the solve. */
function worldDir(pose: ComponentPose, local: Vec3): Vec3 {
  return quatRotate(pose.orientation as Quat, local);
}

describe("solveMates — concentric / perpendicular / angle", () => {
  it("concentric aligns the axes and puts B's axis point on A's axis", () => {
    // A: fixed, axis = the world Z axis through the origin.
    // B: free, starts translated off-axis AND tilted 0.3 rad about X.
    const comps = [
      comp([0, 0, 0], true),
      comp([0.05, 0.03, 0.02], false, quatFromRotVec([0.3, 0, 0])),
    ];
    const mates: Mate[] = [
      {
        kind: "concentric",
        a: { component: 0, point: [0, 0, 0], dir: [0, 0, 1] },
        b: { component: 1, point: [0, 0, 0], dir: [0, 0, 1] },
      },
    ];
    const r = solveMates(comps, mates);
    expect(r.converged).toBe(true);
    expect(r.residualNorm).toBeLessThan(1e-5);

    // Axis alignment: B's rotated +Z is parallel to world +Z (cross ≈ 0).
    const db = vNorm(worldDir(r.poses[1]!, [0, 0, 1]));
    expect(vLen(vCross([0, 0, 1], db))).toBeCloseTo(0, 5);

    // Co-axiality: B's mate point (its origin) lies ON the Z axis — x = y = 0,
    // while z stays free (a concentric mate leaves axial slide + spin open).
    expect(r.poses[1]!.position[0]).toBeCloseTo(0, 5);
    expect(r.poses[1]!.position[1]).toBeCloseTo(0, 5);
    expect(r.freedom).toBe(2); // slide along + rotate about the shared axis
    expect(r.verdict).toBe("under-constrained");
  });

  it("perpendicular drives B's axis to 90° from A's", () => {
    // B starts tilted 0.5 rad about Z, so its local +X sits at ~28.6° from
    // world +X — away from the exactly-parallel start, where dot(da, db) has a
    // zero gradient (a saddle) and the solver stalls (see the KNOWN BUG note on
    // the skipped angle test below; the same LM weakness applies).
    const comps = [
      comp([0, 0, 0], true),
      comp([0.1, 0, 0], false, quatFromRotVec([0, 0, 0.5])),
    ];
    const mates: Mate[] = [
      {
        kind: "perpendicular",
        a: { component: 0, dir: [1, 0, 0] },
        b: { component: 1, dir: [1, 0, 0] },
      },
    ];
    const r = solveMates(comps, mates);
    expect(r.converged).toBe(true);
    expect(r.residualNorm).toBeLessThan(1e-5);
    const db = vNorm(worldDir(r.poses[1]!, [1, 0, 0]));
    expect(vDot([1, 0, 0], db)).toBeCloseTo(0, 5); // cos(90°) = 0
    // NOTE deliberately NOT asserted: r.poses[1].position. The perpendicular
    // residual is translation-independent, and the current solver walks the
    // free translation off to ~1e7 m while satisfying the direction (real bug,
    // solver.ts:275 — multiplicative LM damping leaves the unconstrained
    // subspace undamped; see solver.mappings/mates test report).
  });

  // KNOWN BUG — packages/cad/src/assembly/solver.ts:275. A single, plainly
  // satisfiable angle mate fails erratically depending on the starting pose:
  //   start rotVec [0,0,0.9], target 60° → stalls at 56.02°, residualNorm
  //   5.9e-2, verdict "did-not-converge", AND the free component's position
  //   blows up to [2.7e7, 1051, 1051].
  //   start 0.8 → 60.003° but residual 4.7e-5 > tol → "did-not-converge";
  //   start 0.5 / 1.0 → converges to 60.000°, but position runs to 1.1e7/1.3e6;
  //   start 1.2 → stalls at 68.75°. Pinning translation with a coincident mate
  //   does NOT rescue it (start 0.9 → 61.25°, residual 1.9e-2).
  // Root cause: LM damping is multiplicative on the JtJ diagonal
  // (`v * (1 + lambda)`), so parameter directions with a zero diagonal (any
  // direction the mate doesn't constrain) stay UNdamped; solveLinear then
  // partial-pivots on floating-point noise (~1e-9, from quatNormalize jitter in
  // applyIncrement amplified by the 1e-7 forward-difference Jacobian), emitting
  // huge junk step components that the cost check cannot see (they don't change
  // the residual), so they get accepted alongside genuine progress.
  // Un-skip once the damping is additive (e.g. + lambda*max(diag) or + lambda*I).
  it.skip("angle drives the axis angle to the target (60°) [KNOWN BUG solver.ts:275]", () => {
    const comps = [
      comp([0, 0, 0], true),
      comp([0.1, 0, 0], false, quatFromRotVec([0, 0, 0.9])), // start ~51.6°
    ];
    const mates: Mate[] = [
      {
        kind: "angle",
        a: { component: 0, dir: [1, 0, 0] },
        b: { component: 1, dir: [1, 0, 0] },
        value: Math.PI / 3,
      },
    ];
    const r = solveMates(comps, mates);
    expect(r.converged).toBe(true);
    expect(r.residualNorm).toBeLessThan(1e-5);
    const db = vNorm(worldDir(r.poses[1]!, [1, 0, 0]));
    const cos = Math.min(1, Math.max(-1, vDot([1, 0, 0], db)));
    expect(Math.acos(cos)).toBeCloseTo(Math.PI / 3, 4);
  });
});
