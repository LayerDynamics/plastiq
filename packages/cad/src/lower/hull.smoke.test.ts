// convexHull — SMOKE: hulls a simple point set and returns a well-formed hull.

import { describe, expect, it } from "vitest";

import { convexHull } from "./hull.js";
import type { Vec3 } from "../math/index.js";

const CUBE: Vec3[] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

describe("convexHull — smoke", () => {
  it("returns vertices + triangular faces with in-range indices", () => {
    const hull = convexHull(CUBE);
    expect(hull.vertices.length).toBeGreaterThanOrEqual(4);
    expect(hull.faces.length).toBeGreaterThan(0);
    for (const f of hull.faces) {
      expect(f).toHaveLength(3);
      for (const idx of f) expect(idx).toBeGreaterThanOrEqual(0);
      for (const idx of f) expect(idx).toBeLessThan(hull.vertices.length);
    }
  });
});
