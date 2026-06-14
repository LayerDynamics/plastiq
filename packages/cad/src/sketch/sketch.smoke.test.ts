// Sketch — SMOKE (real OCCT): toWire/toFace run for polygon + circle profiles.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { planeXY } from "../env/plane.js";
import { Sketch } from "./sketch.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("Sketch — smoke", () => {
  it("polygon toWire + toFace and circle toFace produce non-null shapes", () => {
    const poly = new Sketch(planeXY());
    poly.lineTo(0, 0).lineTo(0.05, 0).lineTo(0.05, 0.05).lineTo(0, 0.05);
    const wire = poly.toWire(oc);
    expect(wire.IsNull()).toBe(false);
    wire.delete();
    const face = poly.toFace(oc);
    expect(face.IsNull()).toBe(false);
    face.delete();

    const circleFace = Sketch.circle(planeXY(), 0, 0, 0.03).toFace(oc);
    expect(circleFace.IsNull()).toBe(false);
    circleFace.delete();
  });
});
