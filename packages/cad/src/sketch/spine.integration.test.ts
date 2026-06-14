// buildSpineWire — INTEGRATION (real OCCT): the spine drives a sweep — a profile
// swept along a polyline path yields a positive-volume solid (sweep builds the spine
// wire from the path internally). Composes spine + sketch + action/sweep.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { planeXY } from "../env/plane.js";
import { sweep } from "../action/loft.js";
import { Sketch } from "./sketch.js";
import type { SpinePath } from "./spine.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("spine — sweep along a path (integration)", () => {
  it("a circular profile swept up a straight spine yields a positive-volume solid", () => {
    const path: SpinePath = { kind: "polyline", points: [[0, 0, 0], [0, 0, 0.1]] };
    const solid = sweep(oc, Sketch.circle(planeXY(), 0, 0, 0.02), path);
    expect(solid.volume()).toBeGreaterThan(0);
    solid.delete();
  });
});
