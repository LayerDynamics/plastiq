// R2 geometry core — exercised against the REAL OCCT wasm (no mocks). Runs in
// the Node vitest environment via opencascade.js/dist/node.js.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "./primitives.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("makeBox", () => {
  it("builds a box whose volume is dx·dy·dz", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    // 0.06 × 0.04 × 0.03 = 7.2e-5 m³
    expect(box.volume()).toBeCloseTo(7.2e-5, 10);
    box.delete();
  });

  it("reports an axis-aligned bounding box from the origin", () => {
    const box = makeBox(oc, mm(10), mm(20), mm(30));
    const bb = box.boundingBox();
    // OCCT's Bnd_Box stores a slightly enlarged box (a ~1e-7 m gap), so corner
    // positions carry that tolerance — assert to the micron (precision 6).
    expect(bb.min[0]).toBeCloseTo(0, 6);
    expect(bb.min[1]).toBeCloseTo(0, 6);
    expect(bb.min[2]).toBeCloseTo(0, 6);
    expect(bb.max[0]).toBeCloseTo(mm(10), 6);
    expect(bb.max[1]).toBeCloseTo(mm(20), 6);
    expect(bb.max[2]).toBeCloseTo(mm(30), 6);
    box.delete();
  });

  it("centres a unit box's mass at its geometric centre", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const c = box.centreOfMass();
    expect(c[0]).toBeCloseTo(mm(5), 9);
    expect(c[1]).toBeCloseTo(mm(5), 9);
    expect(c[2]).toBeCloseTo(mm(5), 9);
    box.delete();
  });
});

describe("makeBoxAt", () => {
  it("offsets the box so its min corner sits at the given point", () => {
    const box = makeBoxAt(oc, [mm(5), mm(10), mm(15)], mm(10), mm(10), mm(10));
    const bb = box.boundingBox();
    expect(bb.min[0]).toBeCloseTo(mm(5), 6);
    expect(bb.min[1]).toBeCloseTo(mm(10), 6);
    expect(bb.min[2]).toBeCloseTo(mm(15), 6);
    expect(bb.max[0]).toBeCloseTo(mm(15), 6);
    expect(box.volume()).toBeCloseTo(1e-6, 12);
    box.delete();
  });
});

describe("Solid.copy", () => {
  it("produces an independent duplicate with the same volume", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const dup = box.copy();
    expect(dup.volume()).toBeCloseTo(box.volume(), 12);
    box.delete();
    // dup is still valid after the original is freed
    expect(dup.volume()).toBeCloseTo(8e-6, 12);
    dup.delete();
  });
});
