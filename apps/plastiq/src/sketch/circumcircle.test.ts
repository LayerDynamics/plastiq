import { describe, expect, it } from "vitest";
import { circumcircle } from "./model.js";

describe("circumcircle — circle through three points (FR-16 circle 3-point)", () => {
  it("fits the circle through three points on a known circle", () => {
    // Points on the circle centred (1,2) radius 5: (6,2),(−4,2),(1,7).
    const c = circumcircle([6, 2], [-4, 2], [1, 7])!;
    expect(c.u).toBeCloseTo(1, 9);
    expect(c.v).toBeCloseTo(2, 9);
    expect(c.r).toBeCloseTo(5, 9);
  });

  it("returns null for three collinear points", () => {
    expect(circumcircle([0, 0], [1, 1], [2, 2])).toBeNull();
  });
});
