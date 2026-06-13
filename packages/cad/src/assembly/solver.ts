// First-party 3D assembly mate solver.
//
// Each non-fixed component has a 6-DOF pose (position + orientation). Mates impose
// geometric residuals (coincident points, parallel/perpendicular/concentric axes,
// distances, angles). We minimise the sum of squared residuals with a
// Levenberg–Marquardt iteration over the free components' poses, using a numeric
// Jacobian. DOF is reported from the Jacobian rank at the solution.

import {
  type Quat,
  type Vec3,
  quatFromRotVec,
  quatMul,
  quatNormalize,
  quatRotate,
  vAdd,
  vCross,
  vDot,
  vLen,
  vNorm,
  vSub,
} from "./quat.js";

export interface ComponentPose {
  position: [number, number, number];
  orientation: [number, number, number, number];
  fixed?: boolean;
}

export interface MateRef {
  component: number;
  point?: [number, number, number];
  dir?: [number, number, number];
}

export type Mate =
  | { kind: "coincident"; a: MateRef; b: MateRef }
  | { kind: "concentric"; a: MateRef; b: MateRef }
  | { kind: "parallel"; a: MateRef; b: MateRef }
  | { kind: "perpendicular"; a: MateRef; b: MateRef }
  | { kind: "distance"; a: MateRef; b: MateRef; value: number }
  | { kind: "angle"; a: MateRef; b: MateRef; value: number };

export type JointKind =
  | "revolute"
  | "prismatic"
  | "cylindrical"
  | "fixed"
  | "ball"
  | "planar";

export type AssemblyVerdict =
  | "under-constrained"
  | "well-constrained"
  | "over-constrained"
  | "did-not-converge";

export interface MateSolveResult {
  poses: ComponentPose[];
  verdict: AssemblyVerdict;
  freedom: number;
  /** L2 norm of the final mate residuals (≈0 when fully satisfied). */
  residualNorm: number;
  /**
   * True iff the iteration drove the residual to the solve tolerance — a pose
   * satisfying all mates was found. When false the mates were NOT satisfied, and
   * `verdict` distinguishes WHY: `"over-constrained"` (the residual is at a
   * least-squares minimum > 0 → genuinely conflicting mates) vs
   * `"did-not-converge"` (the residual was still descending when the iteration
   * budget ran out → numerics, not a conflict). The old code reported both as
   * "over-constrained", conflating a hard solve with a contradictory one.
   */
  converged: boolean;
}

/** Residual L2 norm at/below which the mates are considered satisfied. */
const RESIDUAL_TOL = 1e-5;
/** Least-squares gradient norm below which an unsatisfied residual is treated as
 * a true minimum (conflicting mates) rather than an unfinished descent. */
const GRADIENT_TOL = 1e-7;

const DEFAULT_POINT: Vec3 = [0, 0, 0];
const DEFAULT_DIR: Vec3 = [0, 0, 1];

function worldPoint(pose: ComponentPose, local?: readonly number[]): Vec3 {
  const p: Vec3 = local ? [local[0]!, local[1]!, local[2]!] : DEFAULT_POINT;
  return vAdd(pose.position as Vec3, quatRotate(pose.orientation as Quat, p));
}
function worldDir(pose: ComponentPose, local?: readonly number[]): Vec3 {
  const d: Vec3 = local ? [local[0]!, local[1]!, local[2]!] : DEFAULT_DIR;
  return quatRotate(pose.orientation as Quat, d);
}

function residuals(poses: ComponentPose[], mates: Mate[]): number[] {
  const r: number[] = [];
  for (const m of mates) {
    const pa = worldPoint(poses[m.a.component]!, m.a.point);
    const pb = worldPoint(poses[m.b.component]!, m.b.point);
    const da = worldDir(poses[m.a.component]!, m.a.dir);
    const db = worldDir(poses[m.b.component]!, m.b.dir);
    switch (m.kind) {
      case "coincident": {
        const d = vSub(pa, pb);
        r.push(d[0], d[1], d[2]);
        break;
      }
      case "concentric": {
        const axis = vCross(da, db);
        const offset = vCross(vSub(pb, pa), da);
        r.push(axis[0], axis[1], axis[2], offset[0], offset[1], offset[2]);
        break;
      }
      case "parallel": {
        const c = vCross(vNorm(da), vNorm(db));
        r.push(c[0], c[1], c[2]);
        break;
      }
      case "perpendicular":
        r.push(vDot(vNorm(da), vNorm(db)));
        break;
      case "distance":
        r.push(vLen(vSub(pa, pb)) - m.value);
        break;
      case "angle":
        r.push(vDot(vNorm(da), vNorm(db)) - Math.cos(m.value));
        break;
    }
  }
  return r;
}

function clone(poses: ComponentPose[]): ComponentPose[] {
  return poses.map((p) => ({
    position: [...p.position] as [number, number, number],
    orientation: [...p.orientation] as [number, number, number, number],
    fixed: p.fixed,
  }));
}

/** Apply a 6·(free count) increment vector to the free components' poses. */
function applyIncrement(
  poses: ComponentPose[],
  free: number[],
  delta: number[],
): ComponentPose[] {
  const out = clone(poses);
  free.forEach((ci, k) => {
    const o = k * 6;
    const pose = out[ci]!;
    pose.position = [
      pose.position[0] + delta[o]!,
      pose.position[1] + delta[o + 1]!,
      pose.position[2] + delta[o + 2]!,
    ];
    const dq = quatFromRotVec([delta[o + 3]!, delta[o + 4]!, delta[o + 5]!]);
    pose.orientation = quatNormalize(quatMul(dq, pose.orientation as Quat)) as [
      number,
      number,
      number,
      number,
    ];
  });
  return out;
}

/** Numeric Jacobian (M×N) of the residuals w.r.t. the free-component increments. */
function jacobian(poses: ComponentPose[], free: number[], mates: Mate[], r0: number[]): number[][] {
  const n = free.length * 6;
  const eps = 1e-7;
  const cols: number[][] = [];
  for (let c = 0; c < n; c++) {
    const delta = new Array(n).fill(0);
    delta[c] = eps;
    const rc = residuals(applyIncrement(poses, free, delta), mates);
    const col = rc.map((v, i) => (v - r0[i]!) / eps);
    cols.push(col);
  }
  // Transpose cols (N arrays of length M) into rows (M arrays of length N).
  const m = r0.length;
  const J: number[][] = [];
  for (let i = 0; i < m; i++) J.push(cols.map((col) => col[i]!));
  return J;
}

/** Solve the dense linear system A·x = b (Gaussian elimination, partial pivot). */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-15) continue;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    const pv = M[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / pv;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  return M.map((row, i) => (Math.abs(M[i]![i]!) < 1e-15 ? 0 : row[n]! / M[i]![i]!));
}

/** Numeric rank of a matrix via row reduction. */
function matrixRank(rows: number[][], tol: number): number {
  const m = rows.length;
  if (m === 0) return 0;
  const n = rows[0]!.length;
  const A = rows.map((r) => [...r]);
  let rank = 0;
  for (let col = 0; col < n && rank < m; col++) {
    let pivot = -1;
    for (let r = rank; r < m; r++) {
      if (Math.abs(A[r]![col]!) > tol) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) continue;
    [A[rank], A[pivot]] = [A[pivot]!, A[rank]!];
    const pv = A[rank]![col]!;
    for (let r = 0; r < m; r++) {
      if (r === rank) continue;
      const f = A[r]![col]! / pv;
      for (let k = col; k < n; k++) A[r]![k]! -= f * A[rank]![k]!;
    }
    rank++;
  }
  return rank;
}

function sumSq(v: number[]): number {
  return v.reduce((s, x) => s + x * x, 0);
}

/**
 * Position the components so the mates are satisfied. Fixed components don't move.
 * Returns the solved poses plus a three-state verdict and the remaining DOF.
 */
export function solveMates(components: ComponentPose[], mates: Mate[]): MateSolveResult {
  let poses = clone(components);
  const free = components.map((c, i) => (c.fixed ? -1 : i)).filter((i) => i >= 0);
  const n = free.length * 6;

  if (n === 0 || mates.length === 0) {
    return {
      poses,
      verdict: n === 0 ? "well-constrained" : "under-constrained",
      freedom: n,
      residualNorm: 0,
      converged: true,
    };
  }

  let lambda = 1e-3;
  for (let iter = 0; iter < 200; iter++) {
    const r0 = residuals(poses, mates);
    const cost0 = sumSq(r0);
    if (Math.sqrt(cost0) < 1e-10) break;

    const J = jacobian(poses, free, mates, r0);
    // Normal equations: (JᵀJ + λ·diag(JᵀJ)) Δ = −Jᵀr
    const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let i = 0; i < r0.length; i++) {
      const row = J[i]!;
      for (let a = 0; a < n; a++) {
        Jtr[a] += row[a]! * r0[i]!;
        for (let b = 0; b < n; b++) JtJ[a]![b]! += row[a]! * row[b]!;
      }
    }
    const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
    const g = Jtr.map((v) => -v);
    const delta = solveLinear(A, g);

    const trial = applyIncrement(poses, free, delta);
    const cost1 = sumSq(residuals(trial, mates));
    if (cost1 < cost0) {
      poses = trial;
      lambda = Math.max(lambda * 0.5, 1e-9);
    } else {
      lambda = Math.min(lambda * 4, 1e6);
    }
  }

  const finalRes = residuals(poses, mates);
  const residNorm = Math.sqrt(sumSq(finalRes));
  const J = jacobian(poses, free, mates, finalRes);
  const rank = matrixRank(J, 1e-6);
  const freedom = Math.max(0, n - rank);
  const converged = residNorm <= RESIDUAL_TOL;

  let verdict: AssemblyVerdict;
  if (converged) {
    verdict = freedom > 0 ? "under-constrained" : "well-constrained";
  } else {
    // Residual couldn't be satisfied. Gradient g = Jᵀr of the least-squares cost:
    // g ≈ 0 means we sit at a residual MINIMUM (no pose does better → conflicting
    // mates); a sizeable g means the descent was cut short by the iteration budget.
    let gradSq = 0;
    for (let a = 0; a < n; a++) {
      let ga = 0;
      for (let i = 0; i < finalRes.length; i++) ga += J[i]![a]! * finalRes[i]!;
      gradSq += ga * ga;
    }
    verdict = Math.sqrt(gradSq) <= GRADIENT_TOL ? "over-constrained" : "did-not-converge";
  }

  return { poses, verdict, freedom, residualNorm: residNorm, converged };
}
