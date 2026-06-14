// assembly/quat — INTEGRATION: the ops COMPOSED as the mate solver uses them —
// axis-angle → rotate, quaternion composition = sequential rotation, and building an
// orthonormal frame from cross + normalize.

import { describe, expect, it } from "vitest";

import { type Vec3, quatFromRotVec, quatMul, quatRotate, vCross, vDot, vNorm } from "./quat.js";

const near = (a: readonly number[], e: readonly number[], p = 9): void => {
  for (let i = 0; i < e.length; i++) expect(a[i]).toBeCloseTo(e[i]!, p);
};

describe("quat — composed pose math (integration)", () => {
  it("quatFromRotVec → quatRotate rotates a vector about an axis (90° Z: +X → +Y)", () => {
    const q = quatFromRotVec([0, 0, Math.PI / 2]);
    near(quatRotate(q, [1, 0, 0]), [0, 1, 0]);
  });

  it("quatMul composition equals applying the rotations in sequence", () => {
    const qz = quatFromRotVec([0, 0, Math.PI / 2]); // 90° about Z
    const combined = quatMul(qz, qz); // 180° about Z
    const viaCombined = quatRotate(combined, [1, 0, 0]);
    const viaSequence = quatRotate(qz, quatRotate(qz, [1, 0, 0]));
    near(viaCombined, viaSequence);
    near(viaCombined, [-1, 0, 0]); // 180° about Z: +X → −X
  });

  it("vCross + vNorm build an orthonormal frame", () => {
    const x: Vec3 = [1, 0, 0];
    const up: Vec3 = [0, 0, 1];
    const y = vNorm(vCross(up, x)); // → +Y
    near(y, [0, 1, 0], 12);
    expect(vDot(x, y)).toBeCloseTo(0, 12);
  });
});
