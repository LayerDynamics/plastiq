// Tiny dense linear algebra for the sketch solver (SPEC-4 Task 1.3). Self-
// contained (no deps), deterministic. Sized for small sketch systems.

export type Matrix = number[][]; // row-major, m×n

/** A·B for conformable dense matrices. */
export function matMul(a: Matrix, b: Matrix): Matrix {
  const m = a.length;
  const k = b.length;
  const n = b[0]?.length ?? 0;
  const out: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < m; i++) {
    const ai = a[i]!;
    const oi = out[i]!;
    for (let p = 0; p < k; p++) {
      const aip = ai[p]!;
      if (aip === 0) continue;
      const bp = b[p]!;
      for (let j = 0; j < n; j++) oi[j]! += aip * bp[j]!;
    }
  }
  return out;
}

/** Transpose. */
export function transpose(a: Matrix): Matrix {
  const m = a.length;
  const n = a[0]?.length ?? 0;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) out[j]![i] = a[i]![j]!;
  return out;
}

/** Matrix·vector. */
export function matVec(a: Matrix, x: number[]): number[] {
  return a.map((row) => row.reduce((s, v, j) => s + v * x[j]!, 0));
}

/**
 * Solve the square system `A x = b` by Gaussian elimination with partial
 * pivoting. Returns null if A is singular (no unique solution).
 */
export function solveLinear(a: Matrix, b: number[]): number[] | null {
  const n = a.length;
  // Augmented copy.
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    // Partial pivot.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-14) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const pivRow = m[col]!;
    const pivVal = pivRow[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / pivVal;
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) m[r]![j]! -= factor * pivRow[j]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/**
 * Numerical rank of `a` via Gaussian elimination with partial pivoting: the
 * count of pivots whose magnitude exceeds `tol`. Used to classify a sketch's
 * remaining degrees of freedom (well/under/over-constrained).
 */
export function rank(a: Matrix, tol = 1e-9): number {
  const m = a.map((row) => [...row]); // copy
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  let r = 0;
  for (let col = 0; col < cols && r < rows; col++) {
    let pivot = r;
    for (let i = r + 1; i < rows; i++) {
      if (Math.abs(m[i]![col]!) > Math.abs(m[pivot]![col]!)) pivot = i;
    }
    if (Math.abs(m[pivot]![col]!) < tol) continue;
    [m[r], m[pivot]] = [m[pivot]!, m[r]!];
    const pivRow = m[r]!;
    const pivVal = pivRow[col]!;
    for (let i = 0; i < rows; i++) {
      if (i === r) continue;
      const factor = m[i]![col]! / pivVal;
      for (let j = col; j < cols; j++) m[i]![j]! -= factor * pivRow[j]!;
    }
    r++;
  }
  return r;
}
