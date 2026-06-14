// action/pattern — SMOKE (real OCCT): linearPattern + circularPattern produce
// positive-volume instances. Exact counts/placement are in edgecases/loftsweep tests.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { circularPattern, linearPattern } from "./pattern.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("pattern — smoke", () => {
  it("linearPattern produces positive-volume instances", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const copies = linearPattern(oc, box, [1, 0, 0], mm(20), 3);
    expect(copies.length).toBeGreaterThan(0);
    for (const s of copies) {
      expect(s.volume()).toBeGreaterThan(0);
      s.delete();
    }
    box.delete();
  });

  it("circularPattern produces positive-volume instances", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const copies = circularPattern(oc, box, [0, 0, 0], [0, 0, 1], 4, 2 * Math.PI);
    expect(copies.length).toBeGreaterThan(0);
    for (const s of copies) {
      expect(s.volume()).toBeGreaterThan(0);
      s.delete();
    }
    box.delete();
  });
});
