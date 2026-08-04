// generators — analytic tests for the primitive control-lattice generators
// (plane / cylinder / sphere) and the mirror symmetry op. References are the
// closed-form primitives themselves: a bilinear plane, distance-from-axis for the
// cylinder, |p − centre| for the sphere, and an independent reflection for the
// mirror. No OCCT — the point of Lane A(c) is that these are pure math, testable
// analytically.

import { describe, expect, it } from "vitest";

import {
  domain,
  evaluate,
  evaluateWithNormal,
  numU,
  numV,
  validateSurface,
  type NurbsSurface,
  type Vec3,
} from "./index.js";
import { cylinderSurface, mirrorControlNet, planeSurface, sphereSurface } from "./generators.js";

const US = [0.0, 0.11, 0.25, 0.4, 0.5, 0.63, 0.75, 0.9, 1.0];
const VS = [0.0, 0.17, 0.33, 0.5, 0.71, 0.86, 1.0];
// Interior-only samples (avoid the exact poles where the normal is singular).
const UMID = [0.13, 0.37, 0.5, 0.68, 0.91];
const VMID = [0.15, 0.42, 0.6, 0.83];

function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Reflect a POINT across the plane (Q, unit n). */
function reflectPoint(p: Vec3, q: Vec3, n: Vec3): Vec3 {
  const d = dot(sub(p, q), n);
  return [p[0] - 2 * d * n[0], p[1] - 2 * d * n[1], p[2] - 2 * d * n[2]];
}
/** Reflect a free VECTOR across the plane with unit normal n (no translation). */
function reflectVector(v: Vec3, n: Vec3): Vec3 {
  const d = dot(v, n);
  return [v[0] - 2 * d * n[0], v[1] - 2 * d * n[1], v[2] - 2 * d * n[2]];
}

// ---------------------------------------------------------------------------
// planeSurface
// ---------------------------------------------------------------------------

describe("generators — planeSurface", () => {
  const origin: Vec3 = [1, 2, 3];
  const uDir: Vec3 = [2, 0, 0]; // not unit — must be normalized internally
  const vDir: Vec3 = [0, 3, 0];
  const uSize = 5;
  const vSize = 7;
  const s: NurbsSurface = planeSurface(origin, uDir, vDir, uSize, vSize);

  it("is a well-formed degree-1 non-rational patch", () => {
    expect(() => validateSurface(s)).not.toThrow();
    expect(s.degU).toBe(1);
    expect(s.degV).toBe(1);
    expect(numU(s)).toBe(2);
    expect(numV(s)).toBe(2);
    expect(s.weights).toBeUndefined();
  });

  it("evaluates to exact bilinear origin + û·uSize·u + v̂·vSize·v", () => {
    const uHat = normalize(uDir);
    const vHat = normalize(vDir);
    for (const u of US) {
      for (const v of VS) {
        const got = evaluate(s, u, v);
        const ref = add(origin, add(scale(uHat, uSize * u), scale(vHat, vSize * v)));
        expect(got[0]).toBeCloseTo(ref[0], 12);
        expect(got[1]).toBeCloseTo(ref[1], 12);
        expect(got[2]).toBeCloseTo(ref[2], 12);
      }
    }
  });

  it("has the constant normal normalize(û × v̂)", () => {
    // û = +x, v̂ = +y ⇒ normal = +z.
    const { normal } = evaluateWithNormal(s, 0.5, 0.5);
    expect(normal[0]).toBeCloseTo(0, 12);
    expect(normal[1]).toBeCloseTo(0, 12);
    expect(Math.abs(normal[2])).toBeCloseTo(1, 12);
  });
});

// ---------------------------------------------------------------------------
// cylinderSurface
// ---------------------------------------------------------------------------

/** Perpendicular distance from `p` to the infinite line (axisPoint, unit axis). */
function distToAxis(p: Vec3, axisPoint: Vec3, axis: Vec3): number {
  const d = sub(p, axisPoint);
  const along = dot(d, axis);
  const radial = sub(d, scale(axis, along));
  return len(radial);
}
/** Signed coordinate of `p` along the axis, measured from axisPoint. */
function axialCoord(p: Vec3, axisPoint: Vec3, axis: Vec3): number {
  return dot(sub(p, axisPoint), axis);
}

describe("generators — cylinderSurface (full 2π)", () => {
  const axisPoint: Vec3 = [1, -2, 0.5];
  const axis = normalize([1, 1, 1]); // oblique axis to prove the frame is general
  const radius = 3.5;
  const height = 4;
  const s = cylinderSurface(axisPoint, axis, radius, height);

  it("is a well-formed rational degree-(2,1), 9×2 wall with weights 1,√2/2,…", () => {
    expect(() => validateSurface(s)).not.toThrow();
    expect(s.degU).toBe(2);
    expect(s.degV).toBe(1);
    expect(numU(s)).toBe(9);
    expect(numV(s)).toBe(2);
    const h = Math.SQRT1_2;
    const wU = s.weights!.map((row) => row[0]);
    expect(wU).toEqual([1, h, 1, h, 1, h, 1, h, 1]);
  });

  it("evaluates exactly onto the cylinder: dist-to-axis = radius, axial = height·v", () => {
    for (const u of US) {
      for (const v of VS) {
        const p = evaluate(s, u, v);
        expect(distToAxis(p, axisPoint, axis)).toBeCloseTo(radius, 9);
        expect(axialCoord(p, axisPoint, axis)).toBeCloseTo(height * v, 9);
      }
    }
  });

  it("has a radially-outward surface normal on the wall", () => {
    for (const u of UMID) {
      for (const v of VMID) {
        const { position, normal } = evaluateWithNormal(s, u, v);
        // Radial direction from the axis at this point.
        const d = sub(position, axisPoint);
        const radial = normalize(sub(d, scale(axis, dot(d, axis))));
        const align = dot(normal, radial);
        expect(Math.abs(align)).toBeCloseTo(1, 8);
      }
    }
  });
});

describe("generators — cylinderSurface (partial sweeps)", () => {
  const axisPoint: Vec3 = [0, 0, 0];
  const axis: Vec3 = [0, 0, 1];
  const radius = 2;
  const height = 1;

  it("uses the A7.1 quadrant tiering for the control-point count", () => {
    const counts: [number, number][] = [
      [Math.PI / 2, 3], // 1 sub-arc
      [Math.PI, 5], // 2
      [(3 * Math.PI) / 2, 7], // 3
      [2 * Math.PI, 9], // 4
    ];
    for (const [sweep, expected] of counts) {
      const s = cylinderSurface(axisPoint, axis, radius, height, { sweep });
      expect(numU(s)).toBe(expected);
      expect(() => validateSurface(s)).not.toThrow();
    }
  });

  it("stays exactly on the cylinder and spans exactly `sweep` radians", () => {
    for (const sweep of [Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const s = cylinderSurface(axisPoint, axis, radius, height, { sweep });
      // Radius invariant everywhere.
      for (const u of US) {
        for (const v of [0, 0.5, 1]) {
          const p = evaluate(s, u, v);
          expect(distToAxis(p, axisPoint, axis)).toBeCloseTo(radius, 9);
        }
      }
      // Angle between the u=0 and u=1 rays (about the axis) equals the sweep.
      const p0 = evaluate(s, 0, 0);
      const p1 = evaluate(s, 1, 0);
      const r0 = normalize(sub(p0, axisPoint));
      const r1 = normalize(sub(p1, axisPoint));
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(r0, r1))));
      // acos only resolves ≤ π; check the ≤ π sweeps directly and 3π/2 via its
      // supplement (2π − 3π/2 = π/2).
      const expectedAng = sweep <= Math.PI ? sweep : 2 * Math.PI - sweep;
      expect(ang).toBeCloseTo(expectedAng, 8);
    }
  });
});

// ---------------------------------------------------------------------------
// sphereSurface
// ---------------------------------------------------------------------------

describe("generators — sphereSurface", () => {
  const centre: Vec3 = [-1, 4, 2];
  const radius = 2.75;
  const s = sphereSurface(centre, radius);

  it("is a well-formed rational degree-(2,2), 9×5 patch", () => {
    expect(() => validateSurface(s)).not.toThrow();
    expect(s.degU).toBe(2);
    expect(s.degV).toBe(2);
    expect(numU(s)).toBe(9);
    expect(numV(s)).toBe(5);
    expect(s.weights).toBeDefined();
  });

  it("every evaluated point satisfies |p − centre| = radius", () => {
    for (const u of US) {
      for (const v of VS) {
        const p = evaluate(s, u, v);
        expect(len(sub(p, centre))).toBeCloseTo(radius, 9);
      }
    }
  });

  it("collapses the meridian ends onto the poles", () => {
    for (const u of US) {
      const south = evaluate(s, u, 0);
      const north = evaluate(s, u, 1);
      expect(south[0]).toBeCloseTo(centre[0], 9);
      expect(south[1]).toBeCloseTo(centre[1], 9);
      expect(south[2]).toBeCloseTo(centre[2] - radius, 9);
      expect(north[0]).toBeCloseTo(centre[0], 9);
      expect(north[1]).toBeCloseTo(centre[1], 9);
      expect(north[2]).toBeCloseTo(centre[2] + radius, 9);
    }
  });

  it("has an outward radial normal off the poles", () => {
    for (const u of UMID) {
      for (const v of VMID) {
        const { position, normal } = evaluateWithNormal(s, u, v);
        const outward = normalize(sub(position, centre));
        expect(dot(normal, outward)).toBeCloseTo(1, 7);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// mirrorControlNet
// ---------------------------------------------------------------------------

describe("generators — mirrorControlNet", () => {
  const planePoint: Vec3 = [0, 0, 0];
  const planeNormal: Vec3 = [1, 0, 0]; // the yz-plane

  const s = planeSurface([1, 2, 3], [1, 0, 0], [0, 1, 0], 4, 5);
  const m = mirrorControlNet(s, planePoint, planeNormal);

  it("returns a well-formed surface with preserved structure and weights", () => {
    expect(() => validateSurface(m)).not.toThrow();
    expect(m.degU).toBe(s.degU);
    expect(m.degV).toBe(s.degV);
    expect(numU(m)).toBe(numU(s));
    expect(numV(m)).toBe(numV(s));
    expect(m.weights).toBeUndefined(); // non-rational stays non-rational
  });

  it("mirror(u, v) = reflect(original(a+b − u, v)) over the u-span", () => {
    const { u0, u1 } = domain(m); // u-span [a, b]
    for (const u of US) {
      for (const v of VS) {
        const uSrc = u0 + u1 - u;
        const got = evaluate(m, u, v);
        const ref = reflectPoint(evaluate(s, uSrc, v), planePoint, planeNormal);
        expect(got[0]).toBeCloseTo(ref[0], 10);
        expect(got[1]).toBeCloseTo(ref[1], 10);
        expect(got[2]).toBeCloseTo(ref[2], 10);
      }
    }
  });

  it("carries the mirror-image normal (orientation kept sane by u-reversal)", () => {
    // Original plane normal is +z; reflected across the yz-plane it stays +z.
    const nOrig = evaluateWithNormal(s, 0.5, 0.5).normal;
    const expected = reflectVector(nOrig, planeNormal);
    const nMirror = evaluateWithNormal(m, 0.5, 0.5).normal;
    expect(nMirror[0]).toBeCloseTo(expected[0], 10);
    expect(nMirror[1]).toBeCloseTo(expected[1], 10);
    expect(nMirror[2]).toBeCloseTo(expected[2], 10);
  });

  it("preserves geometry of a rational body (mirrored sphere is still a sphere)", () => {
    const centre: Vec3 = [2, 0, 1];
    const radius = 1.5;
    const sph = sphereSurface(centre, radius);
    // Mirror across an oblique plane not through the centre.
    const q: Vec3 = [1, 1, 0];
    const nrm = normalize([1, -2, 0.5]);
    const mSph = mirrorControlNet(sph, q, nrm);
    expect(() => validateSurface(mSph)).not.toThrow();
    expect(mSph.weights).toBeDefined();
    const mCentre = reflectPoint(centre, q, nrm);
    for (const u of US) {
      for (const v of VS) {
        const p = evaluate(mSph, u, v);
        expect(len(sub(p, mCentre))).toBeCloseTo(radius, 9);
      }
    }
  });
});
