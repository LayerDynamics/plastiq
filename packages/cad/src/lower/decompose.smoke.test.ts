// decompose — SMOKE: meshVolume, initDecomposer, decomposerReady, and collidersFor
// (convex path) all run and return sane output. The decomposition correctness +
// concavity gate are in decompose.test.ts (unit + integration).

import { beforeAll, describe, expect, it } from "vitest";

import { collidersFor, decomposerReady, initDecomposer, meshVolume } from "./decompose.js";

// Unit cube: 8 corners (flat) + 12 triangles.
const POS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const FACES: number[][] = [
  [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
];

beforeAll(async () => {
  await initDecomposer();
}, 120_000);

describe("decompose — smoke", () => {
  it("meshVolume returns the cube's volume", () => {
    expect(meshVolume(POS, FACES)).toBeCloseTo(1, 9);
  });

  it("decomposerReady is true once initDecomposer has run", () => {
    expect(decomposerReady()).toBe(true);
  });

  it("collidersFor returns at least one well-formed collider for a convex part", () => {
    const colliders = collidersFor(POS, FACES.flat(), 1.0);
    expect(colliders.length).toBeGreaterThanOrEqual(1);
    expect(colliders[0]!.points.length).toBeGreaterThan(0);
    expect(colliders[0]!.faces.length).toBeGreaterThan(0);
  });
});
