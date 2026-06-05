// 2D variational sketch constraint solver (SPEC-4 FR-2 / Task 1.3).
//
// A real Gauss-Newton / Levenberg-Marquardt solver over the sketch's free
// degrees of freedom (point coordinates + circle radii). Each constraint
// contributes residual equation(s) that must vanish; the solver drives the
// residual to zero, then classifies the system as well- / under- /
// over-constrained from the Jacobian rank vs the DOF count. Deterministic
// (fixed iteration order, no RNG) per SPEC-4 NFR-2.

import { matMul, matVec, rank, solveLinear, transpose, type Matrix } from "./linalg.js";

export interface SolverPoint {
  x: number;
  y: number;
  /** Anchored (not a free unknown) when true. */
  fixed?: boolean;
}

export interface SolverCircle {
  /** Index into the points array (the circle centre). */
  center: number;
  radius: number;
  /** Radius anchored when true. */
  fixed?: boolean;
}

// A line is referenced by its two endpoint indices (a→b).
export type Constraint =
  | { kind: "coincident"; a: number; b: number }
  | { kind: "horizontal"; a: number; b: number }
  | { kind: "vertical"; a: number; b: number }
  | { kind: "distance"; a: number; b: number; value: number }
  | { kind: "hDistance"; a: number; b: number; value: number } // signed Δx = value
  | { kind: "vDistance"; a: number; b: number; value: number } // signed Δy = value
  | { kind: "parallel"; a: number; b: number; c: number; d: number }
  | { kind: "perpendicular"; a: number; b: number; c: number; d: number }
  | { kind: "equalLength"; a: number; b: number; c: number; d: number }
  | { kind: "angle"; a: number; b: number; c: number; d: number; value: number }
  | { kind: "concentric"; a: number; b: number } // two circle-centre point indices
  | { kind: "radius"; circle: number; value: number }
  | { kind: "equalRadius"; a: number; b: number } // two circle indices
  | { kind: "tangentLineCircle"; a: number; b: number; circle: number }
  | { kind: "midpoint"; m: number; a: number; b: number } // m is the midpoint of a→b
  | { kind: "pointOnLine"; p: number; a: number; b: number } // p lies on line a→b
  | { kind: "pointOnCircle"; p: number; circle: number } // p lies on the circle
  | { kind: "symmetric"; a: number; b: number; c: number; d: number }; // a,b mirror across c→d

export type Verdict = "well-constrained" | "under-constrained" | "over-constrained";

export interface SolveResult {
  points: { x: number; y: number }[];
  radii: number[];
  residualNorm: number;
  verdict: Verdict;
  /** Number of free unknowns. */
  dof: number;
  /** Jacobian rank at the solution. */
  rank: number;
  /** Remaining degrees of freedom (dof − rank). */
  freedom: number;
}

export interface SolveOptions {
  maxIterations?: number;
  tolerance?: number;
}

interface State {
  px: number[];
  py: number[];
  radii: number[];
}

const FD_EPS = 1e-7; // central-difference step for the numerical Jacobian

export function solveSketch(
  points: SolverPoint[],
  circles: SolverCircle[],
  constraints: Constraint[],
  opts: SolveOptions = {},
): SolveResult {
  const maxIterations = opts.maxIterations ?? 100;
  const tolerance = opts.tolerance ?? 1e-10;

  const state: State = {
    px: points.map((p) => p.x),
    py: points.map((p) => p.y),
    radii: circles.map((c) => c.radius),
  };

  // Map free unknowns → (kind, index) so we can read/write a flat vector.
  type Unknown = { kind: "px" | "py" | "r"; index: number };
  const unknowns: Unknown[] = [];
  points.forEach((p, i) => {
    if (!p.fixed) {
      unknowns.push({ kind: "px", index: i }, { kind: "py", index: i });
    }
  });
  circles.forEach((c, i) => {
    if (!c.fixed) unknowns.push({ kind: "r", index: i });
  });

  const readVec = (): number[] =>
    unknowns.map((u) =>
      u.kind === "px"
        ? state.px[u.index]!
        : u.kind === "py"
          ? state.py[u.index]!
          : state.radii[u.index]!,
    );
  const writeVec = (v: number[]): void => {
    unknowns.forEach((u, k) => {
      const val = v[k]!;
      if (u.kind === "px") state.px[u.index] = val;
      else if (u.kind === "py") state.py[u.index] = val;
      else state.radii[u.index] = val;
    });
  };

  const radiusOf = (circleIdx: number): number => state.radii[circleIdx]!;
  const centerOf = (circleIdx: number): number => circles[circleIdx]!.center;

  // Residual vector for the current state (one or more scalars per constraint).
  const residual = (): number[] => {
    const r: number[] = [];
    const X = state.px;
    const Y = state.py;
    for (const c of constraints) {
      switch (c.kind) {
        case "coincident":
          r.push(X[c.a]! - X[c.b]!, Y[c.a]! - Y[c.b]!);
          break;
        case "concentric":
          r.push(X[c.a]! - X[c.b]!, Y[c.a]! - Y[c.b]!);
          break;
        case "horizontal":
          r.push(Y[c.a]! - Y[c.b]!);
          break;
        case "vertical":
          r.push(X[c.a]! - X[c.b]!);
          break;
        case "distance": {
          const dx = X[c.b]! - X[c.a]!;
          const dy = Y[c.b]! - Y[c.a]!;
          r.push(Math.hypot(dx, dy) - c.value);
          break;
        }
        case "hDistance":
          r.push(X[c.b]! - X[c.a]! - c.value);
          break;
        case "vDistance":
          r.push(Y[c.b]! - Y[c.a]! - c.value);
          break;
        case "parallel": {
          const ux = X[c.b]! - X[c.a]!,
            uy = Y[c.b]! - Y[c.a]!;
          const vx = X[c.d]! - X[c.c]!,
            vy = Y[c.d]! - Y[c.c]!;
          r.push(ux * vy - uy * vx); // cross = 0
          break;
        }
        case "perpendicular": {
          const ux = X[c.b]! - X[c.a]!,
            uy = Y[c.b]! - Y[c.a]!;
          const vx = X[c.d]! - X[c.c]!,
            vy = Y[c.d]! - Y[c.c]!;
          r.push(ux * vx + uy * vy); // dot = 0
          break;
        }
        case "equalLength": {
          const l1 = Math.hypot(X[c.b]! - X[c.a]!, Y[c.b]! - Y[c.a]!);
          const l2 = Math.hypot(X[c.d]! - X[c.c]!, Y[c.d]! - Y[c.c]!);
          r.push(l1 - l2);
          break;
        }
        case "angle": {
          const ux = X[c.b]! - X[c.a]!,
            uy = Y[c.b]! - Y[c.a]!;
          const vx = X[c.d]! - X[c.c]!,
            vy = Y[c.d]! - Y[c.c]!;
          const cross = ux * vy - uy * vx;
          const dot = ux * vx + uy * vy;
          // |u||v| sin(φ − θ): zero exactly when the signed angle φ equals value.
          r.push(cross * Math.cos(c.value) - dot * Math.sin(c.value));
          break;
        }
        case "radius":
          r.push(radiusOf(c.circle) - c.value);
          break;
        case "equalRadius":
          r.push(radiusOf(c.a) - radiusOf(c.b));
          break;
        case "tangentLineCircle": {
          const cen = centerOf(c.circle);
          const ux = X[c.b]! - X[c.a]!,
            uy = Y[c.b]! - Y[c.a]!;
          const len = Math.hypot(ux, uy);
          const cross = ux * (Y[cen]! - Y[c.a]!) - uy * (X[cen]! - X[c.a]!);
          r.push(cross / len - radiusOf(c.circle)); // signed point-line distance = radius
          break;
        }
        case "midpoint":
          r.push(X[c.m]! - (X[c.a]! + X[c.b]!) / 2, Y[c.m]! - (Y[c.a]! + Y[c.b]!) / 2);
          break;
        case "pointOnLine": {
          const ux = X[c.b]! - X[c.a]!,
            uy = Y[c.b]! - Y[c.a]!;
          // (P − A) × (B − A) = 0: P collinear with the line a→b.
          r.push(ux * (Y[c.p]! - Y[c.a]!) - uy * (X[c.p]! - X[c.a]!));
          break;
        }
        case "pointOnCircle": {
          const cen = centerOf(c.circle);
          r.push(Math.hypot(X[c.p]! - X[cen]!, Y[c.p]! - Y[cen]!) - radiusOf(c.circle));
          break;
        }
        case "symmetric": {
          // Axis direction c→d; A,B mirror across it: their midpoint is on the
          // axis AND the chord A→B is perpendicular to the axis.
          const ax = X[c.d]! - X[c.c]!,
            ay = Y[c.d]! - Y[c.c]!;
          const mx = (X[c.a]! + X[c.b]!) / 2,
            my = (Y[c.a]! + Y[c.b]!) / 2;
          const len = Math.hypot(ax, ay);
          r.push((ax * (my - Y[c.c]!) - ay * (mx - X[c.c]!)) / len); // midpoint on axis
          r.push(ax * (X[c.b]! - X[c.a]!) + ay * (Y[c.b]! - Y[c.a]!)); // chord ⟂ axis
          break;
        }
      }
    }
    return r;
  };

  // Central-difference Jacobian of `residual` wrt the free unknowns.
  const jacobian = (): Matrix => {
    const base = readVec();
    const r0 = residual();
    const m = r0.length;
    const n = unknowns.length;
    const J: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    for (let j = 0; j < n; j++) {
      const saved = base[j]!;
      writeVec(base.map((v, k) => (k === j ? v + FD_EPS : v)));
      const rPlus = residual();
      writeVec(base.map((v, k) => (k === j ? v - FD_EPS : v)));
      const rMinus = residual();
      for (let i = 0; i < m; i++) J[i]![j] = (rPlus[i]! - rMinus[i]!) / (2 * FD_EPS);
      base[j] = saved;
    }
    writeVec(base);
    return J;
  };

  const norm = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

  // Levenberg-Marquardt iterations.
  let lambda = 1e-3;
  let res = residual();
  let lastJ: Matrix = [];
  if (unknowns.length > 0) {
    for (let iter = 0; iter < maxIterations && norm(res) > tolerance; iter++) {
      const J = jacobian();
      const Jt = transpose(J);
      const JtJ = matMul(Jt, J);
      const g = matVec(Jt, res);
      // Damped normal equations: (JᵀJ + λ·diag) δ = −Jᵀr.
      const damped: Matrix = JtJ.map((row, i) =>
        row.map((v, j) => (i === j ? v + lambda * (v || 1) : v)),
      );
      const delta = solveLinear(
        damped,
        g.map((x) => -x),
      );
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const current = readVec();
      writeVec(current.map((v, k) => v + delta[k]!));
      const newRes = residual();
      if (norm(newRes) < norm(res)) {
        res = newRes;
        lambda = Math.max(lambda * 0.5, 1e-12); // good step → less damping
      } else {
        writeVec(current); // reject
        lambda *= 5;
      }
    }
    lastJ = jacobian();
  }

  const residualNorm = norm(res);
  const equationCount = res.length;
  const dof = unknowns.length;
  const jrank = lastJ.length > 0 && dof > 0 ? rank(lastJ) : 0;
  const freedom = dof - jrank;
  const solved = residualNorm <= 1e-7;

  let verdict: Verdict;
  if (!solved) {
    verdict = "over-constrained"; // residual cannot be driven to zero (conflicting)
  } else if (freedom > 0) {
    verdict = "under-constrained"; // free DOF remain (rank < dof)
  } else if (equationCount > jrank) {
    verdict = "over-constrained"; // redundant (consistent) constraints
  } else {
    verdict = "well-constrained";
  }

  return {
    points: points.map((_, i) => ({ x: state.px[i]!, y: state.py[i]! })),
    radii: [...state.radii],
    residualNorm,
    verdict,
    dof,
    rank: jrank,
    freedom,
  };
}
