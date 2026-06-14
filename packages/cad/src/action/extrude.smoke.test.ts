// action/extrude — SMOKE (real OCCT): extrude makes a prism; extrudeToFace pads a
// profile up to a base face. Exact geometry is in features/loftsweep tests.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { planeXY } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { FaceRef } from "../mesh/tagged.js";
import { extrude, extrudeToFace } from "./extrude.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function square(side: number): Sketch {
  const sk = new Sketch(planeXY());
  sk.lineTo(0, 0).lineTo(side, 0).lineTo(side, side).lineTo(0, side);
  return sk;
}

describe("extrude — smoke", () => {
  it("extrude makes a prism of volume side²·height", () => {
    const prism = extrude(oc, square(mm(20)), mm(30));
    expect(prism.volume()).toBeCloseTo(mm(20) * mm(20) * mm(30), 9);
    prism.delete();
  });

  it("extrudeToFace pads a profile up to a base face", () => {
    const base = makeBox(oc, mm(60), mm(40), mm(30));
    const top: FaceRef = {
      normal: tessellateTagged(oc, base).faceGroups.find((g) => Math.round(g.normal[2]) === 1)!.normal,
    };
    const pad = extrudeToFace(oc, square(mm(20)), base, top);
    expect(pad.volume()).toBeGreaterThan(0);
    pad.delete();
    base.delete();
  });
});
