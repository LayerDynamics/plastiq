// catmullRomPoints — the 2D spline sampler used for spline display + hit-testing.
// These pin the interpolation (passes through control points) and the exact
// Catmull-Rom position so a regression in the basis formula is caught.

import { describe, expect, it } from "vitest";
import { catmullRomPoints } from "./spline2d.js";
import type { Px } from "./transform2d.js";

describe("catmullRomPoints", () => {
  it("returns the points unchanged for fewer than 3 (no curve to sample)", () => {
    const two: Px[] = [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
    ];
    expect(catmullRomPoints(two)).toEqual(two);
    expect(catmullRomPoints([{ x: 5, y: 5 }])).toEqual([{ x: 5, y: 5 }]);
  });

  it("interpolates every control point — they land at multiples of perSeg", () => {
    const pts: Px[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
    ];
    const perSeg = 12;
    const out = catmullRomPoints(pts, perSeg);
    expect(out).toHaveLength(1 + (pts.length - 1) * perSeg);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[perSeg]!.x).toBeCloseTo(1, 12);
    expect(out[perSeg]!.y).toBeCloseTo(1, 12);
    expect(out[2 * perSeg]!.x).toBeCloseTo(2, 12);
    expect(out[2 * perSeg]!.y).toBeCloseTo(0, 12);
  });

  it("produces the exact Catmull-Rom position at a segment midpoint", () => {
    const pts: Px[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 0 },
    ];
    const out = catmullRomPoints(pts, 12);
    // Hand-computed Catmull-Rom value at t=0.5 of the first segment (out[6]).
    expect(out[6]!.x).toBeCloseTo(0.4375, 12);
    expect(out[6]!.y).toBeCloseTo(0.5625, 12);
  });

  it("keeps a collinear control polygon collinear and monotonic in x", () => {
    const pts: Px[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    const out = catmullRomPoints(pts, 8);
    for (const p of out) expect(p.y).toBeCloseTo(0, 12);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.x).toBeGreaterThanOrEqual(out[i - 1]!.x - 1e-12);
    }
  });
});
