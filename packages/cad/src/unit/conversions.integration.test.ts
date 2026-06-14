// unit conversions — INTEGRATION tests: authoring → SI → display round-trips, the
// real flow (the kernel ingests authoring units, works in SI, reads back for the UI).

import { describe, expect, it } from "vitest";

import { deg, inch, mm, toDeg, toMm } from "./index.js";

describe("unit conversions — round trips (integration)", () => {
  it("toMm(mm(x)) === x for a length", () => {
    expect(toMm(mm(42))).toBeCloseTo(42, 9);
  });
  it("toDeg(deg(x)) === x for an angle", () => {
    expect(toDeg(deg(37))).toBeCloseTo(37, 9);
  });
  it("authoring units agree once in SI: 1 inch === 25.4 mm", () => {
    expect(toMm(inch(1))).toBeCloseTo(25.4, 9);
  });
});
