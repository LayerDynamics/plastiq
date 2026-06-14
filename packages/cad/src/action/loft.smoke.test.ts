// action/loft — SMOKE (real OCCT): lofting two stacked square sections yields a
// positive-volume solid. Exact (frustum) volume is in loftsweep.test.ts.

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

function square(half: number, z: number): Sketch {
  const sk = new Sketch(offsetPlane(planeXY(), z));
  sk.lineTo(-half, -half).lineTo(half, -half).lineTo(half, half).lineTo(-half, half);
  return sk;
}

describe("loft — smoke", () => {
  it("lofts between two stacked square sections", () => {
    const solid = loft(oc, [square(mm(20), 0), square(mm(10), mm(50))], { ruled: true });
    expect(solid.volume()).toBeGreaterThan(0);
    solid.delete();
  });
});
