// action/transform — SMOKE (real OCCT): translate/rotate/mirror preserve volume;
// translate shifts the COM by the delta. Exact placement is in features.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { mirror, rotate, translate } from "./transform.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("transform — smoke", () => {
  it("translate / rotate / mirror are volume-preserving; translate shifts the COM", () => {
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    const v0 = box.volume();
    const com0 = box.centreOfMass();

    const t = translate(oc, box, [mm(10), 0, 0]);
    expect(t.volume()).toBeCloseTo(v0, 9);
    expect(t.centreOfMass()[0]).toBeCloseTo(com0[0] + mm(10), 6);
    t.delete();

    const r = rotate(oc, box, [0, 0, 0], [0, 0, 1], Math.PI / 2);
    expect(r.volume()).toBeCloseTo(v0, 9);
    r.delete();

    const m = mirror(oc, box, [0, 0, 0], [1, 0, 0]);
    expect(m.volume()).toBeCloseTo(v0, 9);
    m.delete();

    box.delete();
  });
});
