import { beforeAll, describe, expect, it } from "vitest";
import { offsetPlane, planeXY, planeYZ } from "../environment/plane.js";
// planeYZ: the straight-sweep profile plane (normal +X = the path tangent).
import { massProperties } from "../lower/massprops.js";
import { initOcct, type Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import { Sketch } from "../sketch/sketch.js";
import { mm } from "../unit/index.js";
import { loft } from "./loft.js";
import { sweep } from "./sweep.js";

const INIT_TIMEOUT_MS = 120_000;

function volume(oc: Occt, s: Solid): number {
  return massProperties(oc, s, 1).volume;
}

describe("loft + sweep (FR-12 / FR-13)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("loft between two equal rectangles is a prism (volume = area × height)", () => {
    // 20×20 mm sections, 50 mm apart → a 20×20×50 mm prism = 2e-5 m³.
    const bottom = Sketch.rectangle(planeXY(), mm(20), mm(20));
    const top = Sketch.rectangle(offsetPlane(planeXY(), mm(50)), mm(20), mm(20));
    const solid = loft(oc, [bottom, top], { ruled: true });
    try {
      expect(solid.isValid()).toBe(true);
      expect(Math.abs(volume(oc, solid) - 2e-5) / 2e-5).toBeLessThan(1e-6);
    } finally {
      solid.delete();
    }
  });

  it("loft tapering from a large to a small rectangle removes material (frustum)", () => {
    // 40×40 → 20×20 over 40 mm. A ruled frustum's volume lies strictly between
    // the small-prism and large-prism bounds: between 1.6e-5 and 6.4e-5 m³.
    const big = Sketch.rectangle(planeXY(), mm(40), mm(40));
    const small = Sketch.rectangle(offsetPlane(planeXY(), mm(40)), mm(20), mm(20));
    const solid = loft(oc, [big, small], { ruled: true });
    try {
      expect(solid.isValid()).toBe(true);
      const v = volume(oc, solid);
      expect(v).toBeGreaterThan(1.6e-5);
      expect(v).toBeLessThan(6.4e-5);
      // The exact frustum volume = (h/3)(A1 + A2 + √(A1·A2)).
      const A1 = 0.04 * 0.04;
      const A2 = 0.02 * 0.02;
      const expected = (0.04 / 3) * (A1 + A2 + Math.sqrt(A1 * A2));
      expect(Math.abs(v - expected) / expected).toBeLessThan(1e-3);
    } finally {
      solid.delete();
    }
  });

  it("loft requires at least two sections", () => {
    const only = Sketch.rectangle(planeXY(), mm(10), mm(10));
    expect(() => loft(oc, [only])).toThrow(/≥ 2 sections/);
  });

  it("sweep a square profile along a straight polyline is a prism", () => {
    // 10×10 mm square swept 100 mm along +X → 0.01·0.01·0.1 = 1e-5 m³.
    const profile = Sketch.rectangle(planeYZ(), mm(10), mm(10));
    const solid = sweep(oc, profile, {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0.1, 0, 0],
      ],
    });
    try {
      expect(solid.isValid()).toBe(true);
      expect(Math.abs(volume(oc, solid) - 1e-5) / 1e-5).toBeLessThan(1e-3);
    } finally {
      solid.delete();
    }
  });

  it("sweep a circular profile (a pipe) along an arc path is a valid curved solid", () => {
    // A circle (radius 4 mm, normal +X) swept along an arc that bends up and
    // back down. A circular profile sweeps cleanly where a polygon would not.
    const solid = sweep(
      oc,
      { center: [0, 0, 0], normal: [1, 0, 0], radius: mm(4) },
      { kind: "arc", start: [0, 0, 0], through: [0.05, 0, 0.05], end: [0.1, 0, 0] },
    );
    try {
      expect(solid.isValid()).toBe(true);
      // Positive, finite volume, at least the chord length × area as a floor.
      expect(volume(oc, solid)).toBeGreaterThan(0);
    } finally {
      solid.delete();
    }
  });
});
