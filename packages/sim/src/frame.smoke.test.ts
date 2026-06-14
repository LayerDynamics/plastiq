// frame helpers — SMOKE tests. Every exported helper invoked once with sane input,
// checked for the right arity + all-finite output. Depth (identity-safety, the
// rotated-frame math, composition) is in frame.test.ts (unit) and the helpers' use
// in real constraints is in constraint-frame.integration.test.ts.

import { describe, expect, it } from "vitest";

import { conjugate, localAnchor, localAxis, quatMul, type SimQuat, type SimVec3 } from "./frame.js";

const Q: SimQuat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const V: SimVec3 = [1, 2, 3];
const finite = (a: readonly number[], n: number): boolean => a.length === n && a.every(Number.isFinite);

describe("frame helpers — smoke", () => {
  it("conjugate returns a 4-vector of finite numbers", () => {
    expect(finite(conjugate(Q), 4)).toBe(true);
  });
  it("quatMul returns a 4-vector of finite numbers", () => {
    expect(finite(quatMul(Q, Q), 4)).toBe(true);
  });
  it("localAnchor returns a 3-vector of finite numbers", () => {
    expect(finite(localAnchor(V, [0, 0, 0], Q), 3)).toBe(true);
  });
  it("localAxis returns a 3-vector of finite numbers", () => {
    expect(finite(localAxis(V, Q), 3)).toBe(true);
  });
});
