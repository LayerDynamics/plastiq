// math — INTEGRATION tests: the ops COMPOSED into the real geometric calculations
// the kernel performs (a face normal, a vector rejection) — proving they work
// together, not just in isolation.

import { describe, expect, it } from "vitest";

import { cross, dot, length, normalize, scale, sub, type Vec3 } from "./index.js";

describe("math — composed calculations (integration)", () => {
  it("computes a CCW triangle's unit normal via sub → cross → normalize", () => {
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [1, 0, 0];
    const c: Vec3 = [0, 1, 0]; // CCW in the z = 0 plane → normal +Z
    const n = normalize(cross(sub(b, a), sub(c, a)));
    expect(n[0]).toBeCloseTo(0, 12);
    expect(n[1]).toBeCloseTo(0, 12);
    expect(n[2]).toBeCloseTo(1, 12);
  });

  it("splits a point into along/across a direction via dot → scale → sub (projection + rejection)", () => {
    const p: Vec3 = [2, 3, 0];
    const dir = normalize([1, 0, 0]);
    const proj = scale(dir, dot(p, dir)); // component along dir
    const rej = sub(p, proj); // component across dir
    expect(proj).toEqual([2, 0, 0]);
    expect(length(rej)).toBeCloseTo(3, 12);
    // proj and rej are orthogonal and reconstruct p.
    expect(dot(proj, rej)).toBeCloseTo(0, 12);
  });
});
