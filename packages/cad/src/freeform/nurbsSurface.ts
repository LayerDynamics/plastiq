// @plastiq/cad — freeform (NURBS) surface pillar, Lane A(a): the pure-TS surface
// data model + the low-level knot/structure utilities shared by the de Boor
// evaluator (deBoor.ts), the tessellator (tessellate.ts), and the editing ops
// (ops.ts).
//
// This is deliberately SELF-CONTAINED: @plastiq/cad must never depend on
// @plastiq/nurbs (that would invert the dependency direction — the app depends
// on @plastiq/nurbs, and the kernel is embeddable anywhere). So the surface type
// here is our own, not the service's NurbsSurfaceJson wire form. A thin adapter
// from that wire form lives at the app/feature layer, not here.
//
// Spec: FablesFindings.md §15 Lane A(a) — "pure-TS de Boor evaluator + tessellator
// in a new packages/cad/src/freeform/ (no OCCT in the interactive loop)".

/** A point in 3-space. Tuple (not number[]) so component access is `number`, not
 * `number | undefined`, under `noUncheckedIndexedAccess`. */
export type Vec3 = [number, number, number];

/** A homogeneous (weighted) point (wx, wy, wz, w) used internally by every
 * numeric kernel so that rational and non-rational surfaces share one code path:
 * evaluate in homogeneous space, then perspective-divide by w at the very end. */
export type Vec4 = [number, number, number, number];

/**
 * A NURBS (or, without weights, a plain B-spline) tensor-product surface.
 *
 * Indexing convention: `controlNet[i][j]` is the control point at u-index `i`
 * (row, 0..numU-1) and v-index `j` (column, 0..numV-1). `weights`, when present,
 * is parallel: `weights[i][j] > 0`. Absent `weights` ⇒ non-rational (all weights
 * are 1). Knot vectors are non-decreasing; a standard clamped CAD surface repeats
 * the end knots `deg+1` times, but evaluation/insertion do not require clamping
 * (degree elevation does — see ops.ts).
 */
export interface NurbsSurface {
  /** Polynomial degree in u (≥ 1). */
  degU: number;
  /** Polynomial degree in v (≥ 1). */
  degV: number;
  /** u knot vector, length = numU + degU + 1, non-decreasing. */
  knotsU: number[];
  /** v knot vector, length = numV + degV + 1, non-decreasing. */
  knotsV: number[];
  /** numU × numV grid of control points, `controlNet[i][j]`. */
  controlNet: Vec3[][];
  /** Optional numU × numV grid of positive weights; absent ⇒ non-rational. */
  weights?: number[][];
}

/** Tolerance for treating two knot values as equal (multiplicity counting). */
export const KNOT_EPS = 1e-9;

/** Number of control points in the u direction. */
export function numU(surf: NurbsSurface): number {
  return surf.controlNet.length;
}

/** Number of control points in the v direction. */
export function numV(surf: NurbsSurface): number {
  const first = surf.controlNet[0];
  return first ? first.length : 0;
}

/** True when the surface carries an explicit weight grid (rational). */
export function isRational(surf: NurbsSurface): boolean {
  return surf.weights !== undefined;
}

/** The clamped/interior parameter domain in each direction:
 * u ∈ [knotsU[degU], knotsU[numU]], v ∈ [knotsV[degV], knotsV[numV]]. */
export function domain(surf: NurbsSurface): {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
} {
  const nU = numU(surf);
  const nV = numV(surf);
  return {
    u0: surf.knotsU[surf.degU] ?? 0,
    u1: surf.knotsU[nU] ?? 1,
    v0: surf.knotsV[surf.degV] ?? 0,
    v1: surf.knotsV[nV] ?? 1,
  };
}

/** The homogeneous control point (wx, wy, wz, w) at grid index (i, j). */
export function toHomogeneous(surf: NurbsSurface, i: number, j: number): Vec4 {
  const row = surf.controlNet[i];
  const p = row ? row[j] : undefined;
  if (p === undefined) {
    throw new RangeError(`control point (${i}, ${j}) is out of range`);
  }
  const wRow = surf.weights ? surf.weights[i] : undefined;
  const w = wRow && wRow[j] !== undefined ? wRow[j]! : 1;
  return [p[0] * w, p[1] * w, p[2] * w, w];
}

/**
 * Knot span index. Returns the largest `i` with `knots[i] <= u < knots[i+1]`,
 * clamped so that the returned span is a valid basis-function support (in
 * `[deg, numCtrl-1]`). The right endpoint `u == knots[numCtrl]` maps to
 * `numCtrl-1`. (The NURBS Book, Algorithm A2.1, FindSpan.)
 */
export function findSpan(
  numCtrl: number,
  deg: number,
  u: number,
  knots: number[],
): number {
  const n = numCtrl - 1;
  const uEnd = knots[n + 1] ?? Number.POSITIVE_INFINITY;
  if (u >= uEnd) return n;
  const uStart = knots[deg] ?? Number.NEGATIVE_INFINITY;
  if (u <= uStart) return deg;
  let low = deg;
  let high = n + 1;
  let mid = Math.floor((low + high) / 2);
  // Invariant: knots[low] <= u < knots[high].
  while (u < (knots[mid] ?? 0) || u >= (knots[mid + 1] ?? 0)) {
    if (u < (knots[mid] ?? 0)) high = mid;
    else low = mid;
    mid = Math.floor((low + high) / 2);
  }
  return mid;
}

/** Knot span index plus the multiplicity of `u` in the knot vector — the pair
 * Boehm's insertion needs (The NURBS Book, FindSpanMult). */
export function findSpanMult(
  numCtrl: number,
  deg: number,
  u: number,
  knots: number[],
): { span: number; mult: number } {
  const span = findSpan(numCtrl, deg, u, knots);
  let mult = 0;
  for (let i = 0; i < knots.length; i++) {
    if (Math.abs((knots[i] ?? Number.NaN) - u) <= KNOT_EPS) mult++;
  }
  return { span, mult };
}

/**
 * Validate the surface's structural invariants. Throws a descriptive Error on the
 * first violation; returns nothing on success. Not called on the hot path
 * (evaluate/tessellate assume a valid surface) — use it at construction/edit
 * boundaries.
 */
export function validateSurface(surf: NurbsSurface): void {
  if (!Number.isInteger(surf.degU) || surf.degU < 1) {
    throw new Error(`degU must be an integer ≥ 1 (got ${surf.degU})`);
  }
  if (!Number.isInteger(surf.degV) || surf.degV < 1) {
    throw new Error(`degV must be an integer ≥ 1 (got ${surf.degV})`);
  }
  const nU = numU(surf);
  const nV = numV(surf);
  if (nU < surf.degU + 1) {
    throw new Error(
      `need at least degU+1 = ${surf.degU + 1} control rows (got ${nU})`,
    );
  }
  if (nV < surf.degV + 1) {
    throw new Error(
      `need at least degV+1 = ${surf.degV + 1} control columns (got ${nV})`,
    );
  }
  for (let i = 0; i < nU; i++) {
    const row = surf.controlNet[i];
    if (!row || row.length !== nV) {
      throw new Error(
        `control net must be rectangular: row ${i} has ${
          row ? row.length : 0
        } columns, expected ${nV}`,
      );
    }
    for (let j = 0; j < nV; j++) {
      const p = row[j];
      if (
        !p ||
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        !Number.isFinite(p[2])
      ) {
        throw new Error(`control point (${i}, ${j}) is not finite`);
      }
    }
  }
  if (surf.knotsU.length !== nU + surf.degU + 1) {
    throw new Error(
      `knotsU length must be numU + degU + 1 = ${
        nU + surf.degU + 1
      } (got ${surf.knotsU.length})`,
    );
  }
  if (surf.knotsV.length !== nV + surf.degV + 1) {
    throw new Error(
      `knotsV length must be numV + degV + 1 = ${
        nV + surf.degV + 1
      } (got ${surf.knotsV.length})`,
    );
  }
  assertNonDecreasing(surf.knotsU, "knotsU");
  assertNonDecreasing(surf.knotsV, "knotsV");
  if (surf.weights) {
    if (surf.weights.length !== nU) {
      throw new Error(
        `weights must have numU = ${nU} rows (got ${surf.weights.length})`,
      );
    }
    for (let i = 0; i < nU; i++) {
      const wRow = surf.weights[i];
      if (!wRow || wRow.length !== nV) {
        throw new Error(
          `weights row ${i} must have numV = ${nV} entries (got ${
            wRow ? wRow.length : 0
          })`,
        );
      }
      for (let j = 0; j < nV; j++) {
        const w = wRow[j];
        if (w === undefined || !(w > 0) || !Number.isFinite(w)) {
          throw new Error(`weight (${i}, ${j}) must be finite and > 0 (got ${w})`);
        }
      }
    }
  }
}

function assertNonDecreasing(knots: number[], name: string): void {
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1] ?? Number.NaN;
    const b = knots[i] ?? Number.NaN;
    if (!(b >= a)) {
      throw new Error(
        `${name} must be non-decreasing: ${name}[${i - 1}]=${a} > ${name}[${i}]=${b}`,
      );
    }
  }
}

/** Construct + validate a surface (ergonomic entry that guarantees invariants). */
export function makeNurbsSurface(surf: NurbsSurface): NurbsSurface {
  validateSurface(surf);
  return surf;
}

/** A deep copy of a surface (independent arrays), used by ops that return a new
 * surface rather than mutating in place. */
export function cloneSurface(surf: NurbsSurface): NurbsSurface {
  const controlNet: Vec3[][] = surf.controlNet.map((row) =>
    row.map((p) => [p[0], p[1], p[2]] as Vec3),
  );
  const clone: NurbsSurface = {
    degU: surf.degU,
    degV: surf.degV,
    knotsU: surf.knotsU.slice(),
    knotsV: surf.knotsV.slice(),
    controlNet,
  };
  if (surf.weights) {
    clone.weights = surf.weights.map((row) => row.slice());
  }
  return clone;
}
