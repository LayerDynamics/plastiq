import { describe, expect, it } from "vitest";
import { sectionPlane, sectionTFromOffset } from "./section.js";

describe("sectionPlane — clipping plane for a section cut", () => {
  /** three.js clips where normal·point + constant < 0. */
  const distance = (n: [number, number, number], c: number, p: [number, number, number]): number =>
    n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + c;

  it("cuts at the t-fraction of [min,max] and clips only the far side", () => {
    const { normal, constant } = sectionPlane(0, 1, "x", 0.25); // cut at x = 0.25
    expect(normal).toEqual([-1, 0, 0]);
    expect(constant).toBeCloseTo(0.25, 9);
    expect(distance(normal, constant, [0.2, 0, 0])).toBeGreaterThan(0); // near side kept
    expect(distance(normal, constant, [0.3, 0, 0])).toBeLessThan(0); // far side removed
  });

  it("t=0 cuts at min and t=1 cuts at max (boundaries)", () => {
    expect(sectionPlane(-2, 6, "y", 0).constant).toBeCloseTo(-2, 9);
    expect(sectionPlane(-2, 6, "y", 1).constant).toBeCloseTo(6, 9);
    expect(sectionPlane(-2, 6, "y", 0.5).normal).toEqual([0, -1, 0]);
  });

  it("clamps t outside [0,1] and selects the z normal", () => {
    expect(sectionPlane(0, 10, "z", 2).constant).toBeCloseTo(10, 9); // clamped to 1
    expect(sectionPlane(0, 10, "z", -1).constant).toBeCloseTo(0, 9); // clamped to 0
    expect(sectionPlane(0, 10, "z", 0.5).normal).toEqual([0, 0, -1]);
  });
});

describe("sectionTFromOffset — draggable gizmo write-back (handle position → t)", () => {
  it("maps a handle coordinate to its fraction of [min,max]", () => {
    expect(sectionTFromOffset(0, 1, 0.25)).toBeCloseTo(0.25, 9);
    expect(sectionTFromOffset(-2, 6, 2)).toBeCloseTo(0.5, 9); // halfway across [-2,6]
  });

  it("is the inverse of sectionPlane's offset map (round-trips t)", () => {
    const [min, max] = [-2, 6];
    for (const t of [0, 0.1, 0.5, 0.73, 1]) {
      const offset = sectionPlane(min, max, "y", t).constant; // t → world offset
      expect(sectionTFromOffset(min, max, offset)).toBeCloseTo(t, 9); // offset → t
    }
  });

  it("clamps handle positions dragged past the solid's extent to [0,1]", () => {
    expect(sectionTFromOffset(0, 10, 15)).toBe(1); // dragged past max
    expect(sectionTFromOffset(0, 10, -5)).toBe(0); // dragged before min
  });

  it("maps a degenerate (zero-thickness) extent to 0 instead of dividing by zero", () => {
    expect(sectionTFromOffset(4, 4, 4)).toBe(0);
    expect(Number.isNaN(sectionTFromOffset(4, 4, 9))).toBe(false);
  });
});
