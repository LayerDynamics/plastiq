// massProperties — INTEGRATION (real OCCT): the lowering flow — a built solid plus a
// material density from the library yields the body mass the manifest carries.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { defaultLibrary } from "./component.js";
import { massProperties } from "./massprops.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("massProperties — solid + material → body mass (integration)", () => {
  it("masses a 1-litre aluminium block via the material library", () => {
    const box = makeBox(oc, mm(100), mm(100), mm(100)); // 0.001 m³ = 1 L
    const mp = massProperties(oc, box, defaultLibrary().density("aluminum"));
    expect(mp.volume).toBeCloseTo(0.001, 9);
    expect(mp.mass).toBeCloseTo(0.001 * 2700, 6); // 2.7 kg
    box.delete();
  });
});
