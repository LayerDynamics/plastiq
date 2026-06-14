// Sketch — INTEGRATION (real OCCT): a profile flows into a feature — extruding it
// yields a solid whose volume is the profile area × height (Sketch → extrude).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { planeXY } from "../env/plane.js";
import { extrude } from "../action/extrude.js";
import { Sketch } from "./sketch.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("Sketch — profile → extrude (integration)", () => {
  it("a rectangle extrudes to a prism of volume area × height", () => {
    const sk = new Sketch(planeXY());
    sk.lineTo(0, 0).lineTo(0.1, 0).lineTo(0.1, 0.05).lineTo(0, 0.05);
    const solid = extrude(oc, sk, 0.02);
    expect(solid.volume()).toBeCloseTo(0.1 * 0.05 * 0.02, 9); // 1e-4 m³
    solid.delete();
  });

  it("a circle extrudes to a cylinder of volume πr²·h", () => {
    const solid = extrude(oc, Sketch.circle(planeXY(), 0, 0, 0.05), 0.1);
    expect(solid.volume()).toBeCloseTo(Math.PI * 0.05 * 0.05 * 0.1, 5);
    solid.delete();
  });
});
