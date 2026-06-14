// buildSpineWire — SMOKE (real OCCT): a polyline path yields a non-null wire.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { buildSpineWire, type SpinePath } from "./spine.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("buildSpineWire — smoke", () => {
  it("builds a wire from a multi-segment polyline", () => {
    const path: SpinePath = { kind: "polyline", points: [[0, 0, 0], [0, 0, 0.05], [0.05, 0, 0.05]] };
    const wire = buildSpineWire(oc, path);
    expect(wire.IsNull()).toBe(false);
    wire.delete();
  });
});
