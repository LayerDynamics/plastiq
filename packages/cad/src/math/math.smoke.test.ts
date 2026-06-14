// math — SMOKE tests: every op invoked once, output is the right arity + finite.

import { describe, expect, it } from "vitest";

import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "./index.js";

const A: Vec3 = [1, 2, 3];
const B: Vec3 = [4, 5, 6];
const finite3 = (v: Vec3): boolean => v.length === 3 && v.every(Number.isFinite);

describe("math — smoke", () => {
  it("every vector op returns finite output", () => {
    expect(finite3(add(A, B))).toBe(true);
    expect(finite3(sub(A, B))).toBe(true);
    expect(finite3(scale(A, 2))).toBe(true);
    expect(finite3(cross(A, B))).toBe(true);
    expect(finite3(normalize(A))).toBe(true);
    expect(Number.isFinite(dot(A, B))).toBe(true);
    expect(Number.isFinite(length(A))).toBe(true);
  });
});
