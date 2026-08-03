// deBoor — analytic tests for the de Boor surface evaluator and analytic normal.
// References are computed independently (closed-form bilinear, direct Bernstein
// tensor product, the exact rational-quadratic circle) — no OCCT.

import { describe, expect, it } from "vitest";

import { evaluate, evaluateWithNormal, type NurbsSurface, type Vec3 } from "./index.js";

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  const kk = Math.min(k, n - k);
  for (let i = 0; i < kk; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/** Bernstein basis B_{i,n}(t), i = 0..n. */
function bernstein(n: number, t: number): number[] {
  const b: number[] = [];
  for (let i = 0; i <= n; i++) {
    b.push(binom(n, i) * Math.pow(t, i) * Math.pow(1 - t, n - i));
  }
  return b;
}

const SAMPLES = [0.0, 0.13, 0.25, 0.4, 0.5, 0.62, 0.75, 0.9, 1.0];

describe("deBoor — bilinear patch (degU = degV = 1)", () => {
  // Control net chosen so S(u,v) = (u, v, u*v) in closed form.
  const s: NurbsSurface = {
    degU: 1,
    degV: 1,
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
    controlNet: [
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [1, 1, 1],
      ],
    ],
  };

  it("evaluates to the exact bilinear interpolation (u, v, u*v)", () => {
    for (const u of SAMPLES) {
      for (const v of SAMPLES) {
        const p = evaluate(s, u, v);
        expect(p[0]).toBeCloseTo(u, 12);
        expect(p[1]).toBeCloseTo(v, 12);
        expect(p[2]).toBeCloseTo(u * v, 12);
      }
    }
  });
});

describe("deBoor — single Bézier patch (clamped, no interior knots)", () => {
  // degU = degV = 2, a saddle. Reference is the direct Bernstein tensor product.
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

  function bezierRef(u: number, v: number): Vec3 {
    const bu = bernstein(2, u);
    const bv = bernstein(2, v);
    const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const w = bu[i]! * bv[j]!;
        const p = net[i]![j]!;
        out[0] += w * p[0];
        out[1] += w * p[1];
        out[2] += w * p[2];
      }
    }
    return out;
  }

  it("matches direct Bernstein/tensor evaluation", () => {
    for (const u of SAMPLES) {
      for (const v of SAMPLES) {
        const got = evaluate(s, u, v);
        const ref = bezierRef(u, v);
        expect(got[0]).toBeCloseTo(ref[0], 12);
        expect(got[1]).toBeCloseTo(ref[1], 12);
        expect(got[2]).toBeCloseTo(ref[2], 12);
      }
    }
  });
});

describe("deBoor — rational quarter-cylinder (weights = cos/1)", () => {
  const w1 = Math.SQRT1_2; // cos(45°) — the exact quarter-circle weight.
  // Arc (degU = 2) from (1,0) to (0,1) extruded in z (degV = 1) from 0 to 1.
  const s: NurbsSurface = {
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

  it("evaluates onto the exact unit circle radius, with z = v", () => {
    for (const u of SAMPLES) {
      for (const v of SAMPLES) {
        const p = evaluate(s, u, v);
        expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 12);
        expect(p[2]).toBeCloseTo(v, 12);
      }
    }
  });

  it("has a surface normal that points radially outward on the arc", () => {
    // On a cylinder about z, the normal at (x,y,z) is (x, y, 0).
    for (const u of [0.2, 0.5, 0.8]) {
      for (const v of [0.25, 0.75]) {
        const { position, normal } = evaluateWithNormal(s, u, v);
        const radial: Vec3 = [position[0], position[1], 0];
        const rlen = Math.hypot(radial[0], radial[1]);
        // normal is parallel to the radial direction (dot magnitude ≈ 1).
        const dot =
          (normal[0] * radial[0] + normal[1] * radial[1] + normal[2] * radial[2]) /
          rlen;
        expect(Math.abs(dot)).toBeCloseTo(1, 9);
        expect(Math.abs(normal[2])).toBeCloseTo(0, 9);
      }
    }
  });
});

describe("deBoor — evaluate and evaluateWithNormal agree on position", () => {
  // The two paths are independent (de Boor recurrence vs basis-function sum);
  // they must produce the same point.
  const net: Vec3[][] = [];
  for (let i = 0; i < 4; i++) {
    const row: Vec3[] = [];
    for (let j = 0; j < 3; j++) {
      row.push([i + 0.2 * j, j - 0.1 * i, Math.sin(i * 0.7) + Math.cos(j * 0.9)]);
    }
    net.push(row);
  }
  const s: NurbsSurface = {
    degU: 2,
    degV: 2,
    knotsU: [0, 0, 0, 0.5, 1, 1, 1],
    knotsV: [0, 0, 0, 1, 1, 1],
    controlNet: net,
  };

  it("positions match to machine precision", () => {
    for (const u of SAMPLES) {
      for (const v of SAMPLES) {
        const a = evaluate(s, u, v);
        const b = evaluateWithNormal(s, u, v).position;
        expect(b[0]).toBeCloseTo(a[0], 12);
        expect(b[1]).toBeCloseTo(a[1], 12);
        expect(b[2]).toBeCloseTo(a[2], 12);
      }
    }
  });
});
