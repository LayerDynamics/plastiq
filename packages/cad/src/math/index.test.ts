import { describe, expect, it } from "vitest";
import {
  add,
  cross,
  dot,
  length,
  mat3FromQuat,
  mat3Mul,
  mat3Transpose,
  MAT3_IDENTITY,
  normalize,
  quatFromAxisAngle,
  quatMul,
  QUAT_IDENTITY,
  quatNormalize,
  quatRotate,
  scale,
  sub,
  type Vec3,
} from "./index.js";

describe("Vec3", () => {
  it("add/sub/scale", () => {
    expect(add([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
    expect(sub([4, 5, 6], [1, 2, 3])).toEqual([3, 3, 3]);
    expect(scale([1, 2, 3], 2)).toEqual([2, 4, 6]);
  });

  it("dot/cross known values", () => {
    expect(dot([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it("length + normalize to unit length", () => {
    expect(length([3, 4, 0])).toBe(5);
    const n = normalize([0, 0, 5]);
    expect(n).toEqual([0, 0, 1]);
    expect(length(n)).toBeCloseTo(1, 15);
  });

  it("normalize throws on a zero vector (no NaN)", () => {
    expect(() => normalize([0, 0, 0])).toThrow();
  });
});

describe("Quat (x,y,z,w)", () => {
  it("identity is a no-op rotation", () => {
    expect(quatRotate(QUAT_IDENTITY, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("90° about Z maps +X → +Y", () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const r = quatRotate(q, [1, 0, 0]);
    expect(r[0]).toBeCloseTo(0, 12);
    expect(r[1]).toBeCloseTo(1, 12);
    expect(r[2]).toBeCloseTo(0, 12);
  });

  it("composing two 90° Z rotations = 180° (maps +X → -X)", () => {
    const q90 = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const q180 = quatNormalize(quatMul(q90, q90));
    const r = quatRotate(q180, [1, 0, 0]);
    expect(r[0]).toBeCloseTo(-1, 12);
    expect(r[1]).toBeCloseTo(0, 12);
  });
});

describe("Mat3 (row-major)", () => {
  it("identity multiply is a no-op", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
    expect(mat3Mul(MAT3_IDENTITY, [...a])).toEqual([...a]);
  });

  it("transpose", () => {
    expect(mat3Transpose([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });

  it("rotation matrix from identity quat is identity", () => {
    const m = mat3FromQuat(QUAT_IDENTITY);
    for (let i = 0; i < 9; i++) expect(m[i]).toBeCloseTo(MAT3_IDENTITY[i] as number, 15);
  });

  it("mat3FromQuat(90° Z) rotates +X → +Y (consistent with quatRotate)", () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const m = mat3FromQuat(q);
    // row-major M * [1,0,0]^T = first column
    const col0: Vec3 = [m[0], m[3], m[6]];
    expect(col0[0]).toBeCloseTo(0, 12);
    expect(col0[1]).toBeCloseTo(1, 12);
  });
});
