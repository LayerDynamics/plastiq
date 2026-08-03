// @plastiq/cad — freeform pillar: control-net editing ops that change the
// parameterization WITHOUT changing the surface — knot insertion (Boehm) and
// degree elevation. Both are pure math and are the refinement primitives the
// control-net editor exposes (FablesFindings.md §15 Lane A(a): "degree-elevation
// and knot-insertion ops (both pure math, testable analytically)").
//
// Every op operates in homogeneous space so it is exact for rational surfaces,
// and returns a NEW surface (inputs are never mutated).

import {
  cloneSurface,
  findSpanMult,
  isRational,
  KNOT_EPS,
  numU,
  numV,
  toHomogeneous,
  type NurbsSurface,
  type Vec3,
  type Vec4,
} from "./nurbsSurface.js";

function clone4(v: Vec4): Vec4 {
  return [v[0], v[1], v[2], v[3]];
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * Boehm's knot insertion into a single B-spline curve of homogeneous control
 * points — insert value `u` (with existing multiplicity `s`, span `k`) `r` times.
 * Returns the refined knot vector and control polygon, representing the identical
 * curve. (The NURBS Book, Algorithm A5.1, CurveKnotIns.)
 */
function curveKnotIns(
  deg: number,
  knots: number[],
  ctrl: Vec4[],
  u: number,
  k: number,
  s: number,
  r: number,
): { knots: number[]; ctrl: Vec4[] } {
  const np = ctrl.length - 1;
  const mp = np + deg + 1;
  const nq = np + r;

  const UQ = new Array<number>(mp + r + 1).fill(0);
  const Qw = new Array<Vec4>(nq + 1);

  // New knot vector.
  for (let i = 0; i <= k; i++) UQ[i] = knots[i] ?? 0;
  for (let i = 1; i <= r; i++) UQ[k + i] = u;
  for (let i = k + 1; i <= mp; i++) UQ[i + r] = knots[i] ?? 0;

  // Unaltered control points.
  for (let i = 0; i <= k - deg; i++) Qw[i] = clone4(ctrl[i]!);
  for (let i = k - s; i <= np; i++) Qw[i + r] = clone4(ctrl[i]!);

  // Temporary run of the affected control points.
  const Rw = new Array<Vec4>(deg - s + 1);
  for (let i = 0; i <= deg - s; i++) Rw[i] = clone4(ctrl[k - deg + i]!);

  // Insert the knot r times.
  let L = 0;
  for (let j = 1; j <= r; j++) {
    L = k - deg + j;
    for (let i = 0; i <= deg - j - s; i++) {
      const alpha =
        (u - (knots[L + i] ?? 0)) /
        ((knots[i + k + 1] ?? 0) - (knots[L + i] ?? 0));
      const ri = Rw[i]!;
      const ri1 = Rw[i + 1]!;
      Rw[i] = [
        alpha * ri1[0] + (1 - alpha) * ri[0],
        alpha * ri1[1] + (1 - alpha) * ri[1],
        alpha * ri1[2] + (1 - alpha) * ri[2],
        alpha * ri1[3] + (1 - alpha) * ri[3],
      ];
    }
    Qw[L] = clone4(Rw[0]!);
    Qw[k + r - j - s] = clone4(Rw[deg - j - s]!);
  }
  // Load the remaining control points.
  for (let i = L + 1; i < k - s; i++) {
    Qw[i] = clone4(Rw[i - L]!);
  }

  return { knots: UQ, ctrl: Qw };
}

/** The distinct interior knot values (strictly inside the clamped domain), in
 * increasing order, deduplicated within KNOT_EPS. */
function distinctInteriorKnots(knots: number[], deg: number): number[] {
  const u0 = knots[deg] ?? 0;
  const uEnd = knots[knots.length - 1 - deg] ?? 1;
  const seen: number[] = [];
  for (let i = deg + 1; i < knots.length - deg - 1; i++) {
    const v = knots[i] ?? 0;
    if (v > u0 + KNOT_EPS && v < uEnd - KNOT_EPS) {
      if (!seen.some((existing) => Math.abs(existing - v) <= KNOT_EPS)) {
        seen.push(v);
      }
    }
  }
  return seen;
}

/** Degree-elevate a single Bézier segment (degree `p` → `p+t`) of homogeneous
 * points via the standard binomial elevation formula. Endpoints are preserved. */
function elevateBezierSegment(seg: Vec4[], p: number, t: number): Vec4[] {
  const ph = p + t;
  const out: Vec4[] = [];
  for (let i = 0; i <= ph; i++) {
    let x = 0;
    let y = 0;
    let z = 0;
    let w = 0;
    const jMin = Math.max(0, i - t);
    const jMax = Math.min(p, i);
    const denom = binomial(ph, i);
    for (let j = jMin; j <= jMax; j++) {
      const coef = (binomial(p, j) * binomial(t, i - j)) / denom;
      const pj = seg[j]!;
      x += coef * pj[0];
      y += coef * pj[1];
      z += coef * pj[2];
      w += coef * pj[3];
    }
    out.push([x, y, z, w]);
  }
  return out;
}

/**
 * Degree-elevate a single clamped B-spline curve of homogeneous control points
 * by `t`. Method: Bézier-decompose (insert every interior knot to multiplicity
 * `deg`), elevate each Bézier segment, then reassemble with each distinct
 * interior knot at multiplicity `deg+t`. The result is a valid B-spline
 * representing the IDENTICAL curve (Bézier-strip form). Requires a clamped input.
 */
function degreeElevateCurve(
  deg: number,
  knots: number[],
  ctrl: Vec4[],
  t: number,
): { knots: number[]; ctrl: Vec4[] } {
  const u0 = knots[deg] ?? 0;
  const uEnd = knots[knots.length - 1 - deg] ?? 1;
  const interiors = distinctInteriorKnots(knots, deg);

  // Bézier decomposition: raise every interior knot to full multiplicity `deg`.
  let U = knots.slice();
  let P = ctrl.map(clone4);
  for (const val of interiors) {
    const { span, mult } = findSpanMult(P.length, deg, val, U);
    const raise = deg - mult;
    if (raise > 0) {
      const res = curveKnotIns(deg, U, P, val, span, mult, raise);
      U = res.knots;
      P = res.ctrl;
    }
  }

  const nseg = (P.length - 1) / deg; // integer for a clamped, fully-split curve
  const ph = deg + t;

  const elevated: Vec4[] = [];
  for (let s = 0; s < nseg; s++) {
    const seg: Vec4[] = [];
    for (let i = 0; i <= deg; i++) seg.push(P[s * deg + i]!);
    const eseg = elevateBezierSegment(seg, deg, t);
    // Adjacent elevated segments share their boundary point (Bézier elevation
    // preserves endpoints), so skip the first point of every segment after the
    // first to keep the strip watertight.
    const start = s === 0 ? 0 : 1;
    for (let i = start; i < eseg.length; i++) elevated.push(eseg[i]!);
  }

  const newKnots: number[] = [];
  for (let i = 0; i <= ph; i++) newKnots.push(u0);
  for (const val of interiors) {
    for (let i = 0; i < ph; i++) newKnots.push(val);
  }
  for (let i = 0; i <= ph; i++) newKnots.push(uEnd);

  return { knots: newKnots, ctrl: elevated };
}

/** Reassemble a NURBS surface from per-column (u-direction) or per-row
 * (v-direction) homogeneous curves back into the controlNet/weights grid. */
function assembleFromU(
  degU: number,
  degV: number,
  knotsU: number[],
  knotsV: number[],
  columns: Vec4[][],
  nV: number,
  rational: boolean,
): NurbsSurface {
  const newNU = (columns[0] ?? []).length;
  const controlNet: Vec3[][] = [];
  const weights: number[][] = [];
  for (let i = 0; i < newNU; i++) {
    const cnRow: Vec3[] = [];
    const wRow: number[] = [];
    for (let j = 0; j < nV; j++) {
      const h = columns[j]![i]!;
      const w = h[3] === 0 ? 1 : h[3];
      cnRow.push([h[0] / w, h[1] / w, h[2] / w]);
      wRow.push(h[3]);
    }
    controlNet.push(cnRow);
    weights.push(wRow);
  }
  const surf: NurbsSurface = {
    degU,
    degV,
    knotsU: knotsU.slice(),
    knotsV: knotsV.slice(),
    controlNet,
  };
  if (rational) surf.weights = weights;
  return surf;
}

function assembleFromV(
  degU: number,
  degV: number,
  knotsU: number[],
  knotsV: number[],
  rows: Vec4[][],
  nU: number,
  rational: boolean,
): NurbsSurface {
  const controlNet: Vec3[][] = [];
  const weights: number[][] = [];
  for (let i = 0; i < nU; i++) {
    const row = rows[i]!;
    const cnRow: Vec3[] = [];
    const wRow: number[] = [];
    for (let j = 0; j < row.length; j++) {
      const h = row[j]!;
      const w = h[3] === 0 ? 1 : h[3];
      cnRow.push([h[0] / w, h[1] / w, h[2] / w]);
      wRow.push(h[3]);
    }
    controlNet.push(cnRow);
    weights.push(wRow);
  }
  const surf: NurbsSurface = {
    degU,
    degV,
    knotsU: knotsU.slice(),
    knotsV: knotsV.slice(),
    controlNet,
  };
  if (rational) surf.weights = weights;
  return surf;
}

/**
 * Move control point `(i, j)` to `position` (and optionally set its weight).
 * Returns a NEW surface — the interactive control-net drag primitive
 * (FablesFindings §15 Lane A(c): control-point drags re-tessellate without a
 * worker round-trip when only the pure-TS surface is edited).
 *
 * Indices are 0-based into `controlNet`. Out-of-range indices throw named errors.
 * Non-finite positions / non-positive weights are rejected before any clone.
 */
export function moveControlPoint(
  surf: NurbsSurface,
  i: number,
  j: number,
  position: Vec3,
  weight?: number,
): NurbsSurface {
  const nU = numU(surf);
  const nV = numV(surf);
  if (!Number.isInteger(i) || i < 0 || i >= nU) {
    throw new Error(`moveControlPoint: u-index ${i} out of range [0, ${nU})`);
  }
  if (!Number.isInteger(j) || j < 0 || j >= nV) {
    throw new Error(`moveControlPoint: v-index ${j} out of range [0, ${nV})`);
  }
  if (
    !Number.isFinite(position[0]) ||
    !Number.isFinite(position[1]) ||
    !Number.isFinite(position[2])
  ) {
    throw new Error(`moveControlPoint: position must be finite (got ${position})`);
  }
  if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0)) {
    throw new Error(`moveControlPoint: weight must be finite and > 0 (got ${weight})`);
  }

  const next = cloneSurface(surf);
  // Deep-clone the row so we don't share arrays with the input surface.
  next.controlNet[i] = next.controlNet[i]!.map((p, jj) =>
    jj === j ? ([position[0], position[1], position[2]] as Vec3) : ([p[0], p[1], p[2]] as Vec3),
  );
  if (weight !== undefined) {
    if (!next.weights) {
      // Promote non-rational → rational with unit weights, then set the target.
      next.weights = Array.from({ length: nU }, () => Array.from({ length: nV }, () => 1));
    } else {
      next.weights[i] = next.weights[i]!.slice();
    }
    next.weights[i]![j] = weight;
  }
  return next;
}

/** Insert knot value `t` into the u knot vector `r` times (clamped so the total
 * multiplicity never exceeds `degU`). Returns a new, point-identical surface. */
export function insertKnotU(surf: NurbsSurface, t: number, r = 1): NurbsSurface {
  const nU = numU(surf);
  const nV = numV(surf);
  const { span, mult } = findSpanMult(nU, surf.degU, t, surf.knotsU);
  const rr = Math.min(r, surf.degU - mult);
  if (rr <= 0) return cloneSurface(surf);

  const rational = isRational(surf);
  let newKnotsU: number[] = surf.knotsU.slice();
  const columns: Vec4[][] = [];
  for (let j = 0; j < nV; j++) {
    const col: Vec4[] = [];
    for (let i = 0; i < nU; i++) col.push(toHomogeneous(surf, i, j));
    const res = curveKnotIns(surf.degU, surf.knotsU, col, t, span, mult, rr);
    columns[j] = res.ctrl;
    newKnotsU = res.knots;
  }
  return assembleFromU(
    surf.degU,
    surf.degV,
    newKnotsU,
    surf.knotsV,
    columns,
    nV,
    rational,
  );
}

/** Insert knot value `t` into the v knot vector `r` times (clamped so the total
 * multiplicity never exceeds `degV`). Returns a new, point-identical surface. */
export function insertKnotV(surf: NurbsSurface, t: number, r = 1): NurbsSurface {
  const nU = numU(surf);
  const nV = numV(surf);
  const { span, mult } = findSpanMult(nV, surf.degV, t, surf.knotsV);
  const rr = Math.min(r, surf.degV - mult);
  if (rr <= 0) return cloneSurface(surf);

  const rational = isRational(surf);
  let newKnotsV: number[] = surf.knotsV.slice();
  const rows: Vec4[][] = [];
  for (let i = 0; i < nU; i++) {
    const row: Vec4[] = [];
    for (let j = 0; j < nV; j++) row.push(toHomogeneous(surf, i, j));
    const res = curveKnotIns(surf.degV, surf.knotsV, row, t, span, mult, rr);
    rows[i] = res.ctrl;
    newKnotsV = res.knots;
  }
  return assembleFromV(
    surf.degU,
    surf.degV,
    surf.knotsU,
    newKnotsV,
    rows,
    nU,
    rational,
  );
}

/** Elevate the u degree by `t` (default 1). Returns a new, point-identical
 * surface. Requires a clamped u knot vector (the CAD-standard form). */
export function elevateDegreeU(surf: NurbsSurface, t = 1): NurbsSurface {
  if (t <= 0) return cloneSurface(surf);
  const nU = numU(surf);
  const nV = numV(surf);
  const rational = isRational(surf);
  let newKnotsU: number[] = surf.knotsU.slice();
  const columns: Vec4[][] = [];
  for (let j = 0; j < nV; j++) {
    const col: Vec4[] = [];
    for (let i = 0; i < nU; i++) col.push(toHomogeneous(surf, i, j));
    const res = degreeElevateCurve(surf.degU, surf.knotsU, col, t);
    columns[j] = res.ctrl;
    newKnotsU = res.knots;
  }
  return assembleFromU(
    surf.degU + t,
    surf.degV,
    newKnotsU,
    surf.knotsV,
    columns,
    nV,
    rational,
  );
}

/** Elevate the v degree by `t` (default 1). Returns a new, point-identical
 * surface. Requires a clamped v knot vector (the CAD-standard form). */
export function elevateDegreeV(surf: NurbsSurface, t = 1): NurbsSurface {
  if (t <= 0) return cloneSurface(surf);
  const nU = numU(surf);
  const nV = numV(surf);
  const rational = isRational(surf);
  let newKnotsV: number[] = surf.knotsV.slice();
  const rows: Vec4[][] = [];
  for (let i = 0; i < nU; i++) {
    const row: Vec4[] = [];
    for (let j = 0; j < nV; j++) row.push(toHomogeneous(surf, i, j));
    const res = degreeElevateCurve(surf.degV, surf.knotsV, row, t);
    rows[i] = res.ctrl;
    newKnotsV = res.knots;
  }
  return assembleFromV(
    surf.degU,
    surf.degV + t,
    surf.knotsU,
    newKnotsV,
    rows,
    nU,
    rational,
  );
}
