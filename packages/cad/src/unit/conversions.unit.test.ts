// unit conversions — UNIT tests: each helper's exact factor in isolation.

import { describe, expect, it } from "vitest";

import { cm, deg, inch, m, mm, rad, toDeg, toMm } from "./index.js";

describe("unit conversions (unit)", () => {
  it("mm → metres divides by 1000", () => {
    expect(mm(1000)).toBe(1);
    expect(mm(5)).toBeCloseTo(0.005, 12);
  });
  it("cm → metres divides by 100", () => expect(cm(100)).toBe(1));
  it("m → metres is identity", () => expect(m(2.5)).toBe(2.5));
  it("inch → metres multiplies by 0.0254", () => expect(inch(1)).toBeCloseTo(0.0254, 12));
  it("deg → radians", () => {
    expect(deg(180)).toBeCloseTo(Math.PI, 12);
    expect(deg(90)).toBeCloseTo(Math.PI / 2, 12);
  });
  it("rad → radians is identity", () => expect(rad(1.23)).toBe(1.23));
  it("toMm → millimetres multiplies by 1000", () => {
    expect(toMm(1)).toBe(1000);
    expect(toMm(0.005)).toBeCloseTo(5, 9);
  });
  it("toDeg → degrees", () => expect(toDeg(Math.PI)).toBeCloseTo(180, 12));
});
