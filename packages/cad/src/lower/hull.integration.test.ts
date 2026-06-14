// convexHull — INTEGRATION: the hull feeds the collider pipeline, where its mesh is
// measured by meshVolume. Compose the two real functions — hull a point cloud, then
// confirm the resulting mesh's volume matches the shape (convexHull → meshVolume).

import { describe, expect, it } from "vitest";

import { convexHull } from "./hull.js";
import { meshVolume } from "./decompose.js";
import type { Vec3 } from "../math/index.js";

describe("convexHull → meshVolume (integration)", () => {
  it("the unit cube's hull has volume 1", () => {
    const cube: Vec3[] = [
      [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
      [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
    ];
    const hull = convexHull(cube);
    const vol = meshVolume(hull.vertices.flat(), hull.faces);
    expect(vol).toBeCloseTo(1, 9);
  });

  it("a half-size cube's hull has 1/8 the volume", () => {
    const half: Vec3[] = [
      [0, 0, 0], [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0],
      [0, 0, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0.5], [0, 0.5, 0.5],
    ];
    const hull = convexHull(half);
    expect(meshVolume(hull.vertices.flat(), hull.faces)).toBeCloseTo(0.125, 9);
  });
});
