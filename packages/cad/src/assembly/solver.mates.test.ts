// Direct tests for the mate kinds solver.test.ts does not cover: concentric,
// perpendicular, and angle (assembly/solver.ts:36-42 / residuals at :101-127),
// plus position-stability regressions for the orientation-only mates (angle,
// parallel, perpendicular): their residuals are translation-invariant, so the
// free component's position must NOT move. Under the old multiplicative LM
// damping (`diag·(1+λ)`) the unconstrained translation subspace was undamped
// and poses teleported to 1e6–1e7 m; fixed by additive `+λ·s·I` damping.
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

/** |solved position − start position| of a component. */
function positionDrift(pose: ComponentPose, start: Vec3): number {
  return vLen([
    pose.position[0] - start[0],
    pose.position[1] - start[1],
    pose.position[2] - start[2],
  ]);
}

// Orientation-only mates apply zero translational force, so the only position
// motion possible is solver noise: quaternion-normalization jitter (~1e-16)
// amplified through the 1e-7 forward-difference Jacobian → nanometer-scale
// steps (measured ≤ 1.4e-9 m across all cases). 1e-6 m (a micron, on 0.1 m
// parts) is three orders above that noise floor and five below the part scale.
const POS_DRIFT_TOL = 1e-6;

describe("solveMates — concentric / perpendicular / parallel / angle", () => {
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

  it("perpendicular drives B's axis to 90° from A's without moving B", () => {
    // B starts tilted 0.5 rad about Z, so its local +X sits at ~28.6° from
    // world +X (the exactly-parallel saddle start gets its own test below).
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
    // Position stability: the perpendicular residual is translation-invariant,
    // so nothing pushes B — its position must stay put. The old multiplicative
    // LM damping walked it off to 9.5e6 m (solver.ts damping bug, now additive).
    expect(positionDrift(r.poses[1]!, [0.1, 0, 0])).toBeLessThan(POS_DRIFT_TOL);
  });

  it("perpendicular from the exactly-parallel start (zero-gradient saddle) still converges", () => {
    // da ≡ db at the start, so residual dot(da,db) = 1 sits at a saddle where
    // the TRUE gradient is zero. The forward-difference Jacobian's O(eps/2)
    // curvature bias (~-5e-8 per rotation column) supplies a deterministic
    // descent direction, and the additive damping's s→1 fallback (the whole
    // JᵀJ diagonal is ~1e-15 noise there) keeps the first steps bounded, so
    // lambda adaptation walks the pose off the saddle and converges.
    const comps = [comp([0, 0, 0], true), comp([0.1, 0, 0], false)];
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
    expect(vDot([1, 0, 0], db)).toBeCloseTo(0, 5);
    expect(positionDrift(r.poses[1]!, [0.1, 0, 0])).toBeLessThan(POS_DRIFT_TOL);
  });

  it("parallel aligns the axes without moving B", () => {
    const comps = [
      comp([0, 0, 0], true),
      comp([0.1, 0, 0], false, quatFromRotVec([0, 0.4, 0])),
    ];
    const mates: Mate[] = [
      { kind: "parallel", a: { component: 0, dir: [0, 0, 1] }, b: { component: 1, dir: [0, 0, 1] } },
    ];
    const r = solveMates(comps, mates);
    expect(r.converged).toBe(true);
    expect(r.residualNorm).toBeLessThan(1e-5);
    const db = vNorm(worldDir(r.poses[1]!, [0, 0, 1]));
    expect(vLen(vCross([0, 0, 1], db))).toBeCloseTo(0, 5);
    expect(positionDrift(r.poses[1]!, [0.1, 0, 0])).toBeLessThan(POS_DRIFT_TOL);
  });

  // Regression for the solver.ts LM damping bug (fixed): with multiplicative
  // damping (`diag·(1+λ)`) a single satisfiable angle mate failed erratically by
  // starting pose — start rotVec [0,0,0.9] stalled at 56.02° ("did-not-converge",
  // position blown to [2.7e7, 1051, 1051]); start 0.8 hit 60.003° but residual
  // 4.7e-5 > tol; starts 0.5/1.0 converged in angle but teleported position to
  // 1.1e7/1.3e6 m. Root cause: zero-diagonal (unconstrained) directions received
  // zero damping, and solveLinear pivoted on numeric-Jacobian noise. Additive
  // `+λ·s·I` damping fixes all starts (0.5–1.2 all reach 60.000°, |Δp| < 1e-9 m).
  it("angle drives the axis angle to the target (60°) without moving B", () => {
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
    expect(positionDrift(r.poses[1]!, [0.1, 0, 0])).toBeLessThan(POS_DRIFT_TOL);
  });
});
