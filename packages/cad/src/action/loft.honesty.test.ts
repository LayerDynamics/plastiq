// R8 kernel honesty pass — K8: loft (BRepOffsetAPI_ThruSections) now guards on
// IsDone() before trusting Shape(). A ThruSections that cannot loft its sections
// must fail with a CLEAN thrown error (a JS Error, resources freed), never a
// wasm crash. Exercised against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { offsetPlane, planeXY } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { loft } from "./loft.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** A closed square profile of half-size `half` at plane-height `z`. */
function square(half: number, z: number): Sketch {
  const sk = new Sketch(offsetPlane(planeXY(), z));
  sk.lineTo(-half, -half);
  sk.lineTo(half, -half);
  sk.lineTo(half, half);
  sk.lineTo(-half, half);
  return sk;
}

describe("K8 — loft fails cleanly, not with a crash", () => {
  it("throws a NAMED error on two coincident, identical sections (no solid to build)", () => {
    // Both sections are the SAME square on the SAME plane (z=0): ThruSections has
    // zero height to loft through, so it cannot build a solid. Before K8 the only
    // guard was IsNull; now IsDone() (or a re-thrown Standard_Failure caught by the
    // finally) turns this into a clean Error rather than trusting a not-done maker.
    expect(() => loft(oc, [square(mm(20), 0), square(mm(20), 0)], { ruled: true })).toThrow(
      /loft:/,
    );
  });

  it("a genuinely loftable pair still succeeds (the IsDone guard is not over-eager)", () => {
    // Regression guard: adding IsDone() must NOT reject a valid loft. A 20→10 mm
    // square frustum over 50 mm has the closed-form prismatoid volume.
    const solid = loft(oc, [square(mm(20), 0), square(mm(10), mm(50))], { ruled: true });
    const a1 = mm(40) ** 2;
    const a2 = mm(20) ** 2;
    const expected = (mm(50) / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
    expect(solid.isValid()).toBe(true);
    expect(solid.volume()).toBeCloseTo(expected, 8);
    solid.delete();
  });
});
