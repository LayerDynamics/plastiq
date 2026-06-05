import { beforeAll, describe, expect, it } from "vitest";
import { cut } from "../action/cut.js";
import { extrude } from "../action/extrude.js";
import { planeXY } from "../environment/plane.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox, makeBoxAt, makeSphere } from "../solid/primitives.js";
import { Sketch } from "../sketch/sketch.js";
import { mm } from "../unit/index.js";
import { lowerShape } from "./shape.js";

const INIT_TIMEOUT_MS = 120_000;

describe("shape lowering policy (FR-26 / Q7)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("a box solid lowers to a box shape with the right half-extents", () => {
    const box = makeBox(oc, mm(20), mm(30), mm(40));
    try {
      const shape = lowerShape(oc, box);
      expect(shape.kind).toBe("box");
      if (shape.kind === "box") {
        expect(shape.halfExtents[0]).toBeCloseTo(0.01, 9);
        expect(shape.halfExtents[1]).toBeCloseTo(0.015, 9);
        expect(shape.halfExtents[2]).toBeCloseTo(0.02, 9);
      }
    } finally {
      box.delete();
    }
  });

  it("a sphere solid lowers to a sphere shape with the right radius", () => {
    const sphere = makeSphere(oc, mm(25), [mm(10), mm(20), mm(30)]);
    try {
      const shape = lowerShape(oc, sphere);
      expect(shape.kind).toBe("sphere");
      if (shape.kind === "sphere") {
        expect(shape.radius).toBeCloseTo(0.025, 6);
        // COM-relative centre is ≈ origin for a true sphere.
        expect(Math.hypot(...shape.center)).toBeLessThan(1e-6);
      }
    } finally {
      sphere.delete();
    }
  });

  it("an L-bracket (concave) lowers to a convex hull with finite verts/faces", () => {
    // L-bracket: a 40×40×10 mm box with a 20×20 mm corner notch cut out.
    const base = makeBox(oc, mm(40), mm(40), mm(10));
    const notch = makeBoxAt(oc, [mm(20), mm(20), mm(-5)], mm(30), mm(30), mm(20));
    const bracket = cut(oc, base, notch);
    try {
      expect(bracket.isValid()).toBe(true);
      const shape = lowerShape(oc, bracket);
      expect(shape.kind).toBe("convexHull");
      if (shape.kind === "convexHull") {
        expect(shape.vertices.length).toBeGreaterThanOrEqual(4);
        expect(shape.faces.length).toBeGreaterThanOrEqual(4);
        // All coordinates + indices finite/valid.
        for (const v of shape.vertices) expect(v.every(Number.isFinite)).toBe(true);
        for (const f of shape.faces) {
          expect(f.every((i) => Number.isInteger(i) && i >= 0 && i < shape.vertices.length)).toBe(
            true,
          );
        }
      }
    } finally {
      bracket.delete();
      notch.delete();
      base.delete();
    }
  });

  it("a prism (round, non-box) lowers to a convex hull", () => {
    // A regular 24-sided prism stands in for a cylinder: not a box, not a
    // sphere → the convex-hull fallback, which equals the prism itself.
    const profile = Sketch.regularPolygon(planeXY(), 24, mm(15));
    const prism = extrude(oc, profile, mm(30));
    try {
      const shape = lowerShape(oc, prism);
      expect(shape.kind).toBe("convexHull");
    } finally {
      prism.delete();
    }
  });
});
