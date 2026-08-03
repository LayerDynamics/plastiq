// ops — knot insertion (Boehm) and degree elevation must preserve the surface
// point-for-point. We evaluate a battery of (u,v) samples before and after each
// op and require agreement to < 1e-9. Rational surfaces are exercised too.

import { describe, expect, it } from "vitest";

import {
  elevateDegreeU,
  elevateDegreeV,
  evaluate,
  insertKnotU,
  insertKnotV,
  moveControlPoint,
  numU,
  numV,
  planeSurface,
  validateSurface,
  type NurbsSurface,
  type Vec3,
} from "./index.js";

/** 20 interior (u,v) sample points across the unit domain. */
const US = [0.05, 0.23, 0.5, 0.71, 0.94];
const VS = [0.12, 0.37, 0.68, 0.88];

function maxDeviation(a: NurbsSurface, b: NurbsSurface): number {
  let worst = 0;
  for (const u of US) {
    for (const v of VS) {
      const pa = evaluate(a, u, v);
      const pb = evaluate(b, u, v);
      worst = Math.max(
        worst,
        Math.abs(pa[0] - pb[0]),
        Math.abs(pa[1] - pb[1]),
        Math.abs(pa[2] - pb[2]),
      );
    }
  }
  return worst;
}

/** A non-planar polynomial surface with an interior u knot and a Bézier v run. */
function testSurface(): NurbsSurface {
  const net: Vec3[][] = [];
  for (let i = 0; i < 4; i++) {
    const row: Vec3[] = [];
    for (let j = 0; j < 4; j++) {
      row.push([
        i + 0.2 * j,
        j - 0.15 * i,
        Math.sin(i * 0.8) + Math.cos(j * 0.6) + 0.1 * i * j,
      ]);
    }
    net.push(row);
  }
  return {
    degU: 2,
    degV: 3,
    knotsU: [0, 0, 0, 0.5, 1, 1, 1],
    knotsV: [0, 0, 0, 0, 1, 1, 1, 1],
    controlNet: net,
  };
}

/** The rational quarter-cylinder (see deBoor.test.ts). */
function quarterCylinder(): NurbsSurface {
  const w1 = Math.SQRT1_2;
  return {
    degU: 2,
    degV: 1,
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
    controlNet: [
      [
        [1, 0, 0],
        [1, 0, 1],
      ],
      [
        [1, 1, 0],
        [1, 1, 1],
      ],
      [
        [0, 1, 0],
        [0, 1, 1],
      ],
    ],
    weights: [
      [1, 1],
      [w1, w1],
      [1, 1],
    ],
  };
}

describe("ops — knot insertion preserves the surface", () => {
  it("insertKnotU adds a control row and keeps every point (< 1e-9)", () => {
    const s = testSurface();
    const t = insertKnotU(s, 0.25, 1);
    expect(numU(t)).toBe(numU(s) + 1);
    expect(t.knotsU).toContain(0.25);
    expect(() => validateSurface(t)).not.toThrow();
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
  });

  it("insertKnotV adds a control column and keeps every point (< 1e-9)", () => {
    const s = testSurface();
    const t = insertKnotV(s, 0.5, 1);
    expect(numV(t)).toBe(numV(s) + 1);
    expect(() => validateSurface(t)).not.toThrow();
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
  });

  it("re-inserting an existing knot raises its multiplicity, still preserving", () => {
    const s = testSurface();
    const once = insertKnotU(s, 0.5, 1); // 0.5 already present at mult 1 → 2
    expect(numU(once)).toBe(numU(s) + 1);
    expect(maxDeviation(s, once)).toBeLessThan(1e-9);
  });

  it("preserves a rational surface point-for-point (quarter-cylinder)", () => {
    const s = quarterCylinder();
    const t = insertKnotU(s, 0.5, 1);
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
    // Still on the unit circle after refinement.
    for (const u of US) {
      const p = evaluate(t, u, 0.5);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 9);
    }
  });
});

describe("ops — degree elevation preserves the surface", () => {
  it("elevateDegreeU raises degU and keeps every point (< 1e-9)", () => {
    const s = testSurface();
    const t = elevateDegreeU(s);
    expect(t.degU).toBe(s.degU + 1);
    expect(() => validateSurface(t)).not.toThrow();
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
  });

  it("elevateDegreeV raises degV and keeps every point (< 1e-9)", () => {
    const s = testSurface();
    const t = elevateDegreeV(s);
    expect(t.degV).toBe(s.degV + 1);
    expect(() => validateSurface(t)).not.toThrow();
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
  });

  it("elevates a pure Bézier patch (no interior knots) exactly", () => {
    const net: Vec3[][] = [];
    for (let i = 0; i < 3; i++) {
      const row: Vec3[] = [];
      for (let j = 0; j < 3; j++) row.push([i, j, (i - 1) * (j - 1)]);
      net.push(row);
    }
    const s: NurbsSurface = {
      degU: 2,
      degV: 2,
      knotsU: [0, 0, 0, 1, 1, 1],
      knotsV: [0, 0, 0, 1, 1, 1],
      controlNet: net,
    };
    const t = elevateDegreeU(s);
    expect(t.degU).toBe(3);
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
  });

  it("preserves a rational surface (quarter-cylinder stays a circle)", () => {
    const s = quarterCylinder();
    const t = elevateDegreeU(s); // elevate the arc direction, deg 2 → 3
    expect(t.degU).toBe(3);
    expect(() => validateSurface(t)).not.toThrow();
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
    for (const u of US) {
      for (const v of VS) {
        const p = evaluate(t, u, v);
        expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 9);
      }
    }
  });
});

describe("moveControlPoint — control-net drag primitive (§15)", () => {
  it("moves a corner control point and shifts the surface evaluation", () => {
    // 1×1 unit plane: 2×2 control net at (0,0,0)…(1,1,0).
    const s = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], 1, 1);
    const before = evaluate(s, 1, 1); // corner at control (1,1)
    expect(before[2]).toBeCloseTo(0, 12);

    const t = moveControlPoint(s, 1, 1, [1, 1, 0.25]);
    // Input surface is not mutated.
    expect(s.controlNet[1]![1]![2]).toBeCloseTo(0, 12);
    // Dragged corner moves.
    expect(t.controlNet[1]![1]).toEqual([1, 1, 0.25]);
    // Evaluation at the corner follows the control point for a bilinear plane.
    const after = evaluate(t, 1, 1);
    expect(after[2]).toBeCloseTo(0.25, 9);
    // Opposite corner unchanged.
    expect(evaluate(t, 0, 0)[2]).toBeCloseTo(0, 9);
  });

  it("rejects out-of-range indices and non-finite positions", () => {
    const s = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], 1, 1);
    expect(() => moveControlPoint(s, 9, 0, [0, 0, 0])).toThrow(/u-index/);
    expect(() => moveControlPoint(s, 0, -1, [0, 0, 0])).toThrow(/v-index/);
    expect(() => moveControlPoint(s, 0, 0, [NaN, 0, 0])).toThrow(/finite/);
  });
});

describe("elevateDegree composition", () => {
  it("composes elevation in both directions", () => {
    const s = testSurface();
    const t = elevateDegreeV(elevateDegreeU(s));
    expect(t.degU).toBe(s.degU + 1);
    expect(t.degV).toBe(s.degV + 1);
    expect(maxDeviation(s, t)).toBeLessThan(1e-9);
  });
});
