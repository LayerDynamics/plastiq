import { describe, expect, it } from "vitest";
import {
  resolveSectionPlane,
  sectionHandlePosition,
  sectionPlane,
  sectionPlaneFromOriginNormal,
  sectionTFromOffset,
} from "./section.js";

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

  it("flip swaps the kept half-space (Fusion flip)", () => {
    const plain = sectionPlane(0, 1, "x", 0.25, false);
    const flipped = sectionPlane(0, 1, "x", 0.25, true);
    // A point on the far side is clipped without flip, kept with flip.
    expect(distance(plain.normal, plain.constant, [0.3, 0, 0])).toBeLessThan(0);
    expect(distance(flipped.normal, flipped.constant, [0.3, 0, 0])).toBeGreaterThan(0);
    // And vice versa for the near side.
    expect(distance(plain.normal, plain.constant, [0.2, 0, 0])).toBeGreaterThan(0);
    expect(distance(flipped.normal, flipped.constant, [0.2, 0, 0])).toBeLessThan(0);
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

describe("sectionPlaneFromOriginNormal — face-derived cut", () => {
  it("cuts through a plane origin with the given normal", () => {
    // +Z face at z=0.03: remove the +Z side (exterior).
    const { normal, constant } = sectionPlaneFromOriginNormal([0, 0, 0.03], [0, 0, 1], 0, false);
    const d = (p: [number, number, number]): number =>
      normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] + constant;
    expect(d([0, 0, 0.04])).toBeLessThan(0); // above face clipped
    expect(d([0, 0, 0.02])).toBeGreaterThan(0); // below face kept
  });

  it("offset slides the cut along the normal", () => {
    const base = sectionPlaneFromOriginNormal([0, 0, 0], [0, 0, 1], 0);
    const off = sectionPlaneFromOriginNormal([0, 0, 0], [0, 0, 1], 0.01);
    // Cut moves +0.01 along +Z (after our −n convention, constant shifts).
    expect(off.constant).not.toBeCloseTo(base.constant, 9);
  });
});

describe("resolveSectionPlane + handle position", () => {
  const bbox = { min: [0, 0, 0] as [number, number, number], max: [1, 2, 3] as [number, number, number] };

  it("resolves an axis section from the bbox", () => {
    const p = resolveSectionPlane({ axis: "z", t: 0.5 }, bbox);
    expect(p.normal).toEqual([0, 0, -1]);
    expect(p.constant).toBeCloseTo(1.5, 9);
  });

  it("handle sits at the cut through the bbox centre", () => {
    expect(sectionHandlePosition({ axis: "x", t: 0.25 }, bbox)).toEqual([0.25, 1, 1.5]);
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
