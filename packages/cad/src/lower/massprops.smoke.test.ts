// massProperties — SMOKE test (real OCCT): runs on a box, returns finite props.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { massProperties } from "./massprops.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("massProperties — smoke", () => {
  it("returns finite mass / volume / com", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const mp = massProperties(oc, box, 2700);
    expect(Number.isFinite(mp.mass)).toBe(true);
    expect(Number.isFinite(mp.volume)).toBe(true);
    expect(mp.com.every(Number.isFinite)).toBe(true);
    box.delete();
  });
});
