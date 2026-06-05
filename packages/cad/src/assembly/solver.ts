// 3D variational assembly-mate solver (SPEC-4 FR-27 / Task 4.1).
//
// A Gauss-Newton / Levenberg-Marquardt solver over the components' SE(3) poses.
// Each non-fixed component has 6 DOF — 3 translation + 3 rotation (applied as an
// exp-map increment so orientation stays on the manifold). Each mate contributes
// residual scalars (constraint.ts); the solver drives the stacked residual to
// zero, then classifies the system as well- / under- / over-constrained from the
// Jacobian rank vs the DOF count. Deterministic (fixed iteration order, no RNG)
// per SPEC-4 NFR-2 — mirrors the 2D sketch solver (Q6: same in-TS approach).

import {
  add,
  length,
  quatFromAxisAngle,
  quatMul,
  quatNormalize,
  quatRotate,
  scale,
  type Quat,
  type Vec3,
} from "../math/index.js";
import { matMul, matVec, rank, solveLinear, transpose, type Matrix } from "../sketch/linalg.js";
import { mateResiduals, type Mate, type MateRef, type WorldRef } from "./constraint.js";

export interface ComponentPose {
  position: Vec3;
  orientation: Quat;
  /** Grounded (not a free unknown) when true. */
  fixed?: boolean;
}

export type MateVerdict = "well-constrained" | "under-constrained" | "over-constrained";

export interface MateSolveResult {
  poses: ComponentPose[];
  residualNorm: number;
  verdict: MateVerdict;
  /** Number of free unknowns (6 per non-fixed component). */
  dof: number;
  /** Jacobian rank at the solution. */
  rank: number;
  /** Remaining degrees of freedom (dof − rank). */
  freedom: number;
}

export interface MateSolveOptions {
  maxIterations?: number;
  tolerance?: number;
}

const FD_EPS = 1e-7;
const ZERO: Vec3 = [0, 0, 0];

/** Apply a world-frame rotation increment `omega` (rotation vector) to `q`. */
function applyRotation(q: Quat, omega: Vec3): Quat {
  const angle = length(omega);
  if (angle < 1e-15) return q;
  const axis = scale(omega, 1 / angle);
  return quatNormalize(quatMul(quatFromAxisAngle(axis, angle), q));
}

/** Resolve a local geometry ref to world via a component pose. */
function resolveRef(poses: ComponentPose[], ref: MateRef): WorldRef {
  const pose = poses[ref.component]!;
  const localPoint = ref.point ?? ZERO;
  const localDir = ref.dir ?? ZERO;
  return {
    point: add(pose.position, quatRotate(pose.orientation, localPoint)),
    dir: quatRotate(pose.orientation, localDir),
  };
}

function clonePoses(poses: ComponentPose[]): ComponentPose[] {
  return poses.map((p) => ({
    position: [p.position[0], p.position[1], p.position[2]],
    orientation: [p.orientation[0], p.orientation[1], p.orientation[2], p.orientation[3]],
    fixed: p.fixed,
  }));
}

export function solveMates(
  components: ComponentPose[],
  mates: Mate[],
  opts: MateSolveOptions = {},
): MateSolveResult {
  const maxIterations = opts.maxIterations ?? 200;
  const tolerance = opts.tolerance ?? 1e-10;

  let poses = clonePoses(components);

  // Map each component to its free-slot index (−1 if grounded).
  const freeSlot: number[] = [];
  let nFree = 0;
  for (const p of poses) freeSlot.push(p.fixed ? -1 : nFree++);
  const dof = 6 * nFree;

  const residual = (state: ComponentPose[]): number[] => {
    const r: number[] = [];
    for (const m of mates) {
      const a = resolveRef(state, m.a);
      const b = resolveRef(state, m.b);
      r.push(...mateResiduals(m, a, b));
    }
    return r;
  };

  // Apply a flat increment (length `dof`) to a copy of `state`: per free
  // component, [tx,ty,tz] adds to position and [rx,ry,rz] rotates orientation.
  const applyDelta = (state: ComponentPose[], delta: number[]): ComponentPose[] => {
    const next = clonePoses(state);
    for (let i = 0; i < next.length; i++) {
      const slot = freeSlot[i]!;
      if (slot < 0) continue;
      const base = 6 * slot;
      const p = next[i]!;
      p.position = add(p.position, [delta[base]!, delta[base + 1]!, delta[base + 2]!]);
      p.orientation = applyRotation(p.orientation, [
        delta[base + 3]!,
        delta[base + 4]!,
        delta[base + 5]!,
      ]);
    }
    return next;
  };

  const norm = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

  // Central-difference Jacobian of the residual wrt the `dof` increments,
  // evaluated about zero increment from the current poses.
  const jacobian = (): Matrix => {
    const r0 = residual(poses);
    const m = r0.length;
    const J: Matrix = Array.from({ length: m }, () => new Array<number>(dof).fill(0));
    const e = new Array<number>(dof).fill(0);
    for (let j = 0; j < dof; j++) {
      e[j] = FD_EPS;
      const rPlus = residual(applyDelta(poses, e));
      e[j] = -FD_EPS;
      const rMinus = residual(applyDelta(poses, e));
      e[j] = 0;
      for (let i = 0; i < m; i++) J[i]![j] = (rPlus[i]! - rMinus[i]!) / (2 * FD_EPS);
    }
    return J;
  };

  let res = residual(poses);
  let lastJ: Matrix = [];
  let lambda = 1e-3;

  if (dof > 0) {
    for (let iter = 0; iter < maxIterations && norm(res) > tolerance; iter++) {
      const J = jacobian();
      const Jt = transpose(J);
      const JtJ = matMul(Jt, J);
      const g = matVec(Jt, res);
      const damped: Matrix = JtJ.map((row, i) =>
        row.map((v, j) => (i === j ? v + lambda * (v || 1) : v)),
      );
      const delta = solveLinear(
        damped,
        g.map((x) => -x),
      );
      if (!delta) {
        lambda *= 10;
        if (lambda > 1e12) break;
        continue;
      }
      const trial = applyDelta(poses, delta);
      const newRes = residual(trial);
      if (norm(newRes) < norm(res)) {
        poses = trial;
        res = newRes;
        lambda = Math.max(lambda * 0.5, 1e-12);
      } else {
        lambda *= 5;
        if (lambda > 1e12) break;
      }
    }
    lastJ = jacobian();
  }

  const residualNorm = norm(res);
  const jrank = lastJ.length > 0 && dof > 0 ? rank(lastJ) : 0;
  const freedom = dof - jrank;
  const solved = residualNorm <= 1e-7;

  let verdict: MateVerdict;
  if (!solved) {
    // The residual cannot be driven to zero — conflicting (over-constrained).
    verdict = "over-constrained";
  } else if (freedom > 0) {
    verdict = "under-constrained";
  } else {
    verdict = "well-constrained";
  }

  return { poses, residualNorm, verdict, dof, rank: jrank, freedom };
}
