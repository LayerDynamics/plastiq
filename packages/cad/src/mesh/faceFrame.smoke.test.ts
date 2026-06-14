// mesh/faceFrame — SMOKE: faceDatumPlane derives a well-formed frame from a box face.
// Correctness (axis alignment, centring, un-meshed handling) is in faceFrame.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { resolveFaceRef } from "./resolve.js";
import { faceDatumPlane } from "./faceFrame.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("faceDatumPlane — smoke", () => {
  it("derives a unit-normal datum plane from a box face", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const face = resolveFaceRef(oc, box, { normal: [0, 0, 1] })!;
    const plane = faceDatumPlane(oc, face);
    expect(plane.origin.every(Number.isFinite)).toBe(true);
    expect(plane.normal.every(Number.isFinite)).toBe(true);
    expect(plane.xAxis.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2])).toBeCloseTo(1, 6);
    face.delete();
    box.delete();
  });
});
