// massProperties — UNIT tests against the REAL OCCT wasm (no mocks).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { massProperties } from "./massprops.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("massProperties (unit)", () => {
  it("mass = volume × density, volume = dx·dy·dz, com at the box centre", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30)); // 0.06×0.04×0.03 = 7.2e-5 m³
    const mp = massProperties(oc, box, 7850); // structural steel
    expect(mp.volume).toBeCloseTo(7.2e-5, 10);
    expect(mp.mass).toBeCloseTo(7.2e-5 * 7850, 8);
    expect(mp.com[0]).toBeCloseTo(0.03, 6);
    expect(mp.com[1]).toBeCloseTo(0.02, 6);
    expect(mp.com[2]).toBeCloseTo(0.015, 6);
    box.delete();
  });

  it("mass scales linearly with density", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const a = massProperties(oc, box, 1000);
    const b = massProperties(oc, box, 2000);
    expect(b.mass).toBeCloseTo(2 * a.mass, 12);
    expect(a.volume).toBeCloseTo(b.volume, 12); // density doesn't change volume
    box.delete();
  });
});
