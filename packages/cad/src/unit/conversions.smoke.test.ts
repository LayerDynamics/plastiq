// unit conversions — SMOKE tests: every helper invoked, output finite.

import { describe, expect, it } from "vitest";

import { cm, deg, inch, m, mm, rad, toDeg, toMm } from "./index.js";

describe("unit conversions — smoke", () => {
  it("every conversion returns a finite number", () => {
    for (const v of [mm(5), cm(5), m(5), inch(5), deg(45), rad(1), toMm(0.05), toDeg(1)]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
