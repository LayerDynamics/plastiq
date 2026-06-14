// assembly/quat — SMOKE: every op invoked once, output finite.

import { describe, expect, it } from "vitest";

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

const Q: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const V: Vec3 = [1, 2, 3];
const fin = (a: readonly number[]): boolean => a.every(Number.isFinite);

describe("quat — smoke", () => {
  it("every quaternion/vector op returns finite output", () => {
    expect(fin(quatMul(Q, Q))).toBe(true);
    expect(fin(quatRotate(Q, V))).toBe(true);
    expect(fin(quatFromRotVec(V))).toBe(true);
    expect(fin(quatNormalize(Q))).toBe(true);
    expect(fin(vAdd(V, V))).toBe(true);
    expect(fin(vSub(V, V))).toBe(true);
    expect(fin(vCross(V, V))).toBe(true);
    expect(fin(vNorm(V))).toBe(true);
    expect(Number.isFinite(vDot(V, V))).toBe(true);
    expect(Number.isFinite(vLen(V))).toBe(true);
  });
});
