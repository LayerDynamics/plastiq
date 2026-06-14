// math — UNIT tests: each vector op's exact contract in isolation.

import { describe, expect, it } from "vitest";

import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "./index.js";

describe("math — vector ops (unit)", () => {
  const A: Vec3 = [1, 2, 3];
  const B: Vec3 = [4, 5, 6];

  it("add is component-wise", () => expect(add(A, B)).toEqual([5, 7, 9]));
  it("sub is component-wise", () => expect(sub(B, A)).toEqual([3, 3, 3]));
  it("scale multiplies every component", () => expect(scale([1, -2, 3], 2)).toEqual([2, -4, 6]));
  it("dot is the sum of products", () => expect(dot(A, B)).toBe(32));
  it("dot of perpendicular axes is 0", () => expect(dot([1, 0, 0], [0, 1, 0])).toBe(0));
  it("cross of +X,+Y is +Z (right-handed)", () => expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]));
  it("cross is anti-commutative", () => expect(cross(B, A)).toEqual(scale(cross(A, B), -1)));
  it("length is the Euclidean norm", () => expect(length([3, 4, 0])).toBe(5));
  it("normalize returns a unit vector in the same direction", () => {
    const n = normalize([0, 3, 4]);
    expect(n).toEqual([0, 0.6, 0.8]);
    expect(length(n)).toBeCloseTo(1, 12);
  });
  it("normalize throws on a zero-length vector", () => {
    expect(() => normalize([0, 0, 0])).toThrow(/zero-length/);
  });
});
