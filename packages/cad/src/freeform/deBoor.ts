// @plastiq/cad — freeform pillar: the numerically-stable de Boor surface
// evaluator and its analytic surface normal.
//
// `evaluate` uses the de Boor recurrence (repeated affine interpolation) — the
// numerically stable way to evaluate a B-spline, tensor-product in v then u, in
// homogeneous space so rational and non-rational surfaces share one path.
//
// `evaluateWithNormal` computes the point AND a unit normal from the two analytic
// first partial derivatives ∂S/∂u, ∂S/∂v. Those come from the basis-function
// derivatives (The NURBS Book, A2.3 DersBasisFuns) combined with the exact
// rational quotient rule (Eq. 4.20), so the normal is analytic — no finite
// differences, no step-size tuning.
//
// Spec: FablesFindings.md §15 Lane A(a).

import {
  domain,
  findSpan,
  numU,
  numV,
  toHomogeneous,
  type NurbsSurface,
  type Vec3,
  type Vec4,
} from "./nurbsSurface.js";

/** de Boor recurrence on a span-local run of `deg+1` homogeneous control points.
 *
 * `local[m]` corresponds to the global control point at index `span - deg + m`.
 * `knots` is the full knot vector (the recurrence reads it by global index).
 * Returns the evaluated homogeneous point. */
function deBoor1D(
  deg: number,
  knots: number[],
  local: Vec4[],
  span: number,
  u: number,
): Vec4 {
  // Working copy so the caller's array is untouched.
  const d: Vec4[] = local.map((p) => [p[0], p[1], p[2], p[3]] as Vec4);
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const i = span - deg + j;
      const denom = (knots[i + deg - r + 1] ?? 0) - (knots[i] ?? 0);
      const a = denom === 0 ? 0 : (u - (knots[i] ?? 0)) / denom;
      const dj = d[j] ?? [0, 0, 0, 0];
      const dp = d[j - 1] ?? [0, 0, 0, 0];
      d[j] = [
        (1 - a) * dp[0] + a * dj[0],
        (1 - a) * dp[1] + a * dj[1],
        (1 - a) * dp[2] + a * dj[2],
        (1 - a) * dp[3] + a * dj[3],
      ];
    }
  }
  return d[deg] ?? [0, 0, 0, 1];
}

/**
 * Evaluate the surface at parameter `(u, v)` via the de Boor recurrence.
 *
 * Tensor product: for each of the `degU+1` u-rows in the u-span, run de Boor in v
 * to collapse the v-direction to a single homogeneous point; then run de Boor in u
 * on those `degU+1` points. Perspective-divide by w to land in 3-space.
 */
export function evaluate(surf: NurbsSurface, u: number, v: number): Vec3 {
  const nU = numU(surf);
  const nV = numV(surf);
  const uspan = findSpan(nU, surf.degU, u, surf.knotsU);
  const vspan = findSpan(nV, surf.degV, v, surf.knotsV);

  // Stage 1 — de Boor in v on each relevant u-row → degU+1 homogeneous points.
  const temp: Vec4[] = [];
  for (let l = 0; l <= surf.degU; l++) {
    const iu = uspan - surf.degU + l;
    const vRow: Vec4[] = [];
    for (let m = 0; m <= surf.degV; m++) {
      const iv = vspan - surf.degV + m;
      vRow.push(toHomogeneous(surf, iu, iv));
    }
    temp.push(deBoor1D(surf.degV, surf.knotsV, vRow, vspan, v));
  }

  // Stage 2 — de Boor in u on the collapsed points.
  const sw = deBoor1D(surf.degU, surf.knotsU, temp, uspan, u);
  const w = sw[3] === 0 ? 1 : sw[3];
  return [sw[0] / w, sw[1] / w, sw[2] / w];
}

/**
 * Basis functions and their first derivatives at `u`, restricted to the `deg+1`
 * functions non-zero on the span. Returns `[values, firstDerivs]`, each of length
 * `deg+1` (index `m` ↔ global basis function `span - deg + m`).
 *
 * The NURBS Book, Algorithm A2.3 (DersBasisFuns), specialized to derivative order
 * 1.
 */
function dersBasisFuns(
  span: number,
  u: number,
  deg: number,
  knots: number[],
): [number[], number[]] {
  const ndu: number[][] = Array.from({ length: deg + 1 }, () =>
    new Array<number>(deg + 1).fill(0),
  );
  const left = new Array<number>(deg + 1).fill(0);
  const right = new Array<number>(deg + 1).fill(0);
  (ndu[0] as number[])[0] = 1;

  for (let j = 1; j <= deg; j++) {
    left[j] = u - (knots[span + 1 - j] ?? 0);
    right[j] = (knots[span + j] ?? 0) - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      // Lower triangle: the knot differences.
      (ndu[j] as number[])[r] = (right[r + 1] ?? 0) + (left[j - r] ?? 0);
      const temp = (ndu[r] as number[])[j - 1]! / (ndu[j] as number[])[r]!;
      // Upper triangle: the basis values.
      (ndu[r] as number[])[j] = saved + (right[r + 1] ?? 0) * temp;
      saved = (left[j - r] ?? 0) * temp;
    }
    (ndu[j] as number[])[j] = saved;
  }

  const values = new Array<number>(deg + 1).fill(0);
  for (let j = 0; j <= deg; j++) values[j] = (ndu[j] as number[])[deg]!;

  // First derivatives via the A2.3 recurrence (order n = 1).
  const derivs = new Array<number>(deg + 1).fill(0);
  const a: number[][] = [new Array<number>(deg + 1).fill(0), new Array<number>(deg + 1).fill(0)];
  for (let r = 0; r <= deg; r++) {
    let s1 = 0;
    let s2 = 1;
    (a[0] as number[])[0] = 1;
    // k = 1 (first derivative only).
    let d = 0;
    const rk = r - 1;
    const pk = deg - 1;
    if (r >= 1) {
      (a[s2] as number[])[0] = (a[s1] as number[])[0]! / (ndu[pk + 1] as number[])[rk]!;
      d = (a[s2] as number[])[0]! * (ndu[rk] as number[])[pk]!;
    }
    const j1 = rk >= -1 ? 1 : -rk;
    const j2 = r - 1 <= pk ? 0 : deg - r;
    for (let j = j1; j <= j2; j++) {
      (a[s2] as number[])[j] =
        ((a[s1] as number[])[j]! - (a[s1] as number[])[j - 1]!) /
        (ndu[pk + 1] as number[])[rk + j]!;
      d += (a[s2] as number[])[j]! * (ndu[rk + j] as number[])[pk]!;
    }
    if (r <= pk) {
      (a[s2] as number[])[1] = -(a[s1] as number[])[0]! / (ndu[pk + 1] as number[])[r]!;
      d += (a[s2] as number[])[1]! * (ndu[r] as number[])[pk]!;
    }
    derivs[r] = d;
    const t = s1;
    s1 = s2;
    s2 = t;
  }
  // Multiply the first derivative by the factor `deg`.
  for (let j = 0; j <= deg; j++) derivs[j] = (derivs[j] ?? 0) * deg;

  return [values, derivs];
}

/** The exact rational surface point and its two first partial derivatives at
 * `(u, v)` (The NURBS Book, Eq. 4.20 quotient rule applied to the homogeneous
 * B-spline surface derivatives). */
function surfaceDerivs(
  surf: NurbsSurface,
  u: number,
  v: number,
): { S: Vec3; Su: Vec3; Sv: Vec3 } {
  const nU = numU(surf);
  const nV = numV(surf);
  const uspan = findSpan(nU, surf.degU, u, surf.knotsU);
  const vspan = findSpan(nV, surf.degV, v, surf.knotsV);
  const [uVal, uDer] = dersBasisFuns(uspan, u, surf.degU, surf.knotsU);
  const [vVal, vDer] = dersBasisFuns(vspan, v, surf.degV, surf.knotsV);

  // Homogeneous surface value + u/v first derivatives.
  const Sw: Vec4 = [0, 0, 0, 0];
  const Swu: Vec4 = [0, 0, 0, 0];
  const Swv: Vec4 = [0, 0, 0, 0];

  for (let l = 0; l <= surf.degU; l++) {
    const iu = uspan - surf.degU + l;
    // Collapse v first: value-weighted and v-derivative-weighted homogeneous sums.
    const t0: Vec4 = [0, 0, 0, 0];
    const t1: Vec4 = [0, 0, 0, 0];
    for (let m = 0; m <= surf.degV; m++) {
      const iv = vspan - surf.degV + m;
      const pw = toHomogeneous(surf, iu, iv);
      const nv0 = vVal[m] ?? 0;
      const nv1 = vDer[m] ?? 0;
      t0[0] += nv0 * pw[0];
      t0[1] += nv0 * pw[1];
      t0[2] += nv0 * pw[2];
      t0[3] += nv0 * pw[3];
      t1[0] += nv1 * pw[0];
      t1[1] += nv1 * pw[1];
      t1[2] += nv1 * pw[2];
      t1[3] += nv1 * pw[3];
    }
    const nu0 = uVal[l] ?? 0;
    const nu1 = uDer[l] ?? 0;
    Sw[0] += nu0 * t0[0];
    Sw[1] += nu0 * t0[1];
    Sw[2] += nu0 * t0[2];
    Sw[3] += nu0 * t0[3];
    Swu[0] += nu1 * t0[0];
    Swu[1] += nu1 * t0[1];
    Swu[2] += nu1 * t0[2];
    Swu[3] += nu1 * t0[3];
    Swv[0] += nu0 * t1[0];
    Swv[1] += nu0 * t1[1];
    Swv[2] += nu0 * t1[2];
    Swv[3] += nu0 * t1[3];
  }

  const w = Sw[3] === 0 ? 1 : Sw[3];
  const S: Vec3 = [Sw[0] / w, Sw[1] / w, Sw[2] / w];
  // Quotient rule: S_u = (A_u - w_u S) / w, likewise S_v.
  const Su: Vec3 = [
    (Swu[0] - Swu[3] * S[0]) / w,
    (Swu[1] - Swu[3] * S[1]) / w,
    (Swu[2] - Swu[3] * S[2]) / w,
  ];
  const Sv: Vec3 = [
    (Swv[0] - Swv[3] * S[0]) / w,
    (Swv[1] - Swv[3] * S[1]) / w,
    (Swv[2] - Swv[3] * S[2]) / w,
  ];
  return { S, Su, Sv };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function lengthOf(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalizeOrZero(a: Vec3): Vec3 {
  const len = lengthOf(a);
  if (len < 1e-15) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/**
 * Evaluate the surface point AND its unit normal at `(u, v)`.
 *
 * The normal is `normalize(∂S/∂u × ∂S/∂v)` from the analytic rational derivatives.
 * At a degenerate/pole parameter (the two partials become parallel — e.g. a
 * sphere apex), the cross product collapses; there we nudge `(u, v)` slightly
 * toward the domain interior and recompute, which yields the correct limiting
 * normal for the standard pole configurations.
 */
export function evaluateWithNormal(
  surf: NurbsSurface,
  u: number,
  v: number,
): { position: Vec3; normal: Vec3 } {
  const { S, Su, Sv } = surfaceDerivs(surf, u, v);
  let n = cross(Su, Sv);
  if (lengthOf(n) < 1e-12) {
    const { u0, u1, v0, v1 } = domain(surf);
    const du = (u1 - u0) * 1e-6 || 1e-6;
    const dv = (v1 - v0) * 1e-6 || 1e-6;
    const un = Math.min(Math.max(u + (u <= (u0 + u1) / 2 ? du : -du), u0), u1);
    const vn = Math.min(Math.max(v + (v <= (v0 + v1) / 2 ? dv : -dv), v0), v1);
    const nudged = surfaceDerivs(surf, un, vn);
    n = cross(nudged.Su, nudged.Sv);
  }
  return { position: S, normal: normalizeOrZero(n) };
}
