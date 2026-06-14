// action/revolve — SMOKE (real OCCT): an axis-offset profile revolved 360° about Z
// yields a positive-volume solid of revolution. Exact volume is in features.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { planeXZ } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { revolve } from "./revolve.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("revolve — smoke", () => {
  it("revolves an offset rectangle about the Z axis into a ring solid", () => {
    const sk = new Sketch(planeXZ()); // offset from the axis (u ≥ 20mm)
    sk.lineTo(mm(20), 0).lineTo(mm(40), 0).lineTo(mm(40), mm(20)).lineTo(mm(20), mm(20));
    const solid = revolve(oc, sk, [0, 0, 0], [0, 0, 1], 2 * Math.PI);
    expect(solid.volume()).toBeGreaterThan(0);
    solid.delete();
  });
});
