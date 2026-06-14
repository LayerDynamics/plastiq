// solid — SMOKE (real OCCT): makeBox / makeBoxAt + every Solid accessor run and
// return sane output. Dimensional correctness is in primitives.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "./primitives.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("solid — smoke", () => {
  it("makeBox + every Solid accessor run cleanly", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    expect(box.isValid()).toBe(true);
    expect(box.volume()).toBeGreaterThan(0);
    expect(box.centreOfMass().every(Number.isFinite)).toBe(true);
    const bb = box.boundingBox();
    expect(bb.min.every(Number.isFinite)).toBe(true);
    expect(bb.max.every(Number.isFinite)).toBe(true);
    const clone = box.copy();
    expect(clone.volume()).toBeCloseTo(box.volume(), 12);
    clone.delete();
    box.delete();
  });

  it("makeBoxAt builds a positive-volume box at an offset corner", () => {
    const box = makeBoxAt(oc, [mm(10), mm(10), mm(10)], mm(20), mm(20), mm(20));
    expect(box.volume()).toBeGreaterThan(0);
    box.delete();
  });
});
