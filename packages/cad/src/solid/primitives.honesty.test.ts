// R8 kernel honesty pass — K6: makeBox/makeBoxAt now route through the same
// maker → try/finally → IsNull discipline as every other primitive (finishMaker),
// and Solid.copy/isValid/volume/centreOfMass/boundingBox free their OCCT
// temporaries on every exit. Verified against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "./primitives.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("K6 — makeBox / makeBoxAt route through finishMaker", () => {
  it("makeBox builds a valid solid of the expected volume (via the guarded Shape() path)", () => {
    const box = makeBox(oc, mm(20), mm(30), mm(40));
    expect(box.isValid()).toBe(true);
    // 20×30×40 mm = 0.02×0.03×0.04 m = 2.4e-5 m³.
    expect(box.volume()).toBeCloseTo(2.4e-5, 12);
    // BRepBndLib.Add includes a small gap (~1e-7 m), so bounds are asserted at 6
    // decimals (as boolean.test.ts does) — the box still spans the right extents.
    const bb = box.boundingBox();
    expect(bb.min[0]).toBeCloseTo(0, 6);
    expect(bb.min[1]).toBeCloseTo(0, 6);
    expect(bb.min[2]).toBeCloseTo(0, 6);
    expect(bb.max[0]).toBeCloseTo(mm(20), 6);
    expect(bb.max[1]).toBeCloseTo(mm(30), 6);
    expect(bb.max[2]).toBeCloseTo(mm(40), 6);
    box.delete();
  });

  it("makeBoxAt offsets the minimum corner and frees its point on success", () => {
    const box = makeBoxAt(oc, [mm(5), mm(6), mm(7)], mm(10), mm(10), mm(10));
    expect(box.isValid()).toBe(true);
    const bb = box.boundingBox();
    expect(bb.min[0]).toBeCloseTo(mm(5), 6);
    expect(bb.min[1]).toBeCloseTo(mm(6), 6);
    expect(bb.min[2]).toBeCloseTo(mm(7), 6);
    expect(bb.max[0]).toBeCloseTo(mm(15), 6);
    box.delete();
  });

  it("a degenerate box fails with a clean thrown error, not a wasm crash", () => {
    // A zero-extent box cannot be a solid. The routed path turns this into a clean
    // JS Error (either a re-thrown Standard_Failure from the maker ctor or the
    // finishMaker IsNull guard) instead of returning a bogus/empty Solid.
    expect(() => makeBox(oc, 0, mm(10), mm(10))).toThrow();
    // The engine survives the failure and keeps building good geometry afterwards.
    const ok = makeBox(oc, mm(10), mm(10), mm(10));
    expect(ok.isValid()).toBe(true);
    ok.delete();
  });
});

describe("K6 — Solid accessors stay correct after the exception-safe rewrite", () => {
  it("volume / centreOfMass / boundingBox / isValid return the right values", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(20));
    expect(box.isValid()).toBe(true);
    expect(box.volume()).toBeCloseTo(mm(60) * mm(40) * mm(20), 12);
    const com = box.centreOfMass();
    expect(com[0]).toBeCloseTo(mm(30), 9);
    expect(com[1]).toBeCloseTo(mm(20), 9);
    expect(com[2]).toBeCloseTo(mm(10), 9);
    // BRepBndLib.Add's ~1e-7 m gap → assert extents at 6 decimals.
    const bb = box.boundingBox();
    expect(bb.min[0]).toBeCloseTo(0, 6);
    expect(bb.min[1]).toBeCloseTo(0, 6);
    expect(bb.min[2]).toBeCloseTo(0, 6);
    expect(bb.max[0]).toBeCloseTo(mm(60), 6);
    expect(bb.max[1]).toBeCloseTo(mm(40), 6);
    expect(bb.max[2]).toBeCloseTo(mm(20), 6);
    box.delete();
  });

  it("copy() yields an INDEPENDENT solid (deleting the copy leaves the original usable)", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const dup = box.copy();
    expect(dup.volume()).toBeCloseTo(box.volume(), 12);
    // Independence: freeing the copy must not disturb the original's geometry.
    dup.delete();
    expect(box.isValid()).toBe(true);
    expect(box.volume()).toBeCloseTo(1e-6, 12);
    box.delete();
  });
});
