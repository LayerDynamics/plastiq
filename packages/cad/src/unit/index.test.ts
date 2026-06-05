import { describe, expect, it } from "vitest";
import { cm, deg, inch, mm, rad, toDeg, toMm } from "./index.js";

describe("unit conversions → SI", () => {
  it("mm → m", () => {
    expect(mm(1000)).toBe(1);
    expect(mm(10)).toBeCloseTo(0.01, 15);
  });

  it("cm → m", () => {
    expect(cm(100)).toBe(1);
  });

  it("inch → m (exact 0.0254)", () => {
    expect(inch(1)).toBe(0.0254);
    expect(inch(12)).toBeCloseTo(0.3048, 15);
  });

  it("deg → rad", () => {
    expect(deg(180)).toBe(Math.PI);
    expect(deg(90)).toBeCloseTo(Math.PI / 2, 15);
    expect(rad(Math.PI)).toBe(Math.PI);
  });

  it("round-trips back to display units", () => {
    expect(toMm(mm(37))).toBeCloseTo(37, 12);
    expect(toDeg(deg(45))).toBeCloseTo(45, 12);
  });
});
