// assembly/quat — UNIT tests: each quaternion/vector op's exact contract.

import { describe, expect, it } from "vitest";

import {
  IDENTITY_QUAT,
  type Quat,
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

const S = Math.SQRT1_2;
const near = (a: readonly number[], e: readonly number[], p = 12): void => {
  expect(a).toHaveLength(e.length);
  for (let i = 0; i < e.length; i++) expect(a[i]).toBeCloseTo(e[i]!, p);
};

describe("quat — quaternion ops (unit)", () => {
  it("quatMul: identity is the unit; two 90°-Z compose to 180°-Z", () => {
    const q: Quat = [0.1, 0.2, 0.3, 0.4];
    near(quatMul(IDENTITY_QUAT, q), q);
    near(quatMul(q, IDENTITY_QUAT), q);
    near(quatMul([0, 0, S, S], [0, 0, S, S]), [0, 0, 1, 0]);
  });

  it("quatRotate: 90° about Z maps +X → +Y", () => {
    near(quatRotate([0, 0, S, S], [1, 0, 0]), [0, 1, 0]);
  });

  it("quatFromRotVec: zero → identity; π/2 about Z → [0,0,S,S]", () => {
    near(quatFromRotVec([0, 0, 0]), IDENTITY_QUAT);
    near(quatFromRotVec([0, 0, Math.PI / 2]), [0, 0, S, S]);
  });

  it("quatNormalize scales to unit length", () => {
    near(quatNormalize([0, 0, 0, 2]), [0, 0, 0, 1]);
    expect(Math.hypot(...quatNormalize([1, 2, 3, 4]))).toBeCloseTo(1, 12);
  });

  it("vector ops: add/sub/dot/cross/len/norm", () => {
    near(vAdd([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
    near(vSub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
    expect(vDot([1, 2, 3], [4, 5, 6])).toBe(32);
    near(vCross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
    expect(vLen([3, 4, 0])).toBe(5);
    near(vNorm([0, 3, 4]), [0, 0.6, 0.8]);
  });
});
