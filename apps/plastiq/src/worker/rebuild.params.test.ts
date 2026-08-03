// R6 — live global parameters. `doc.params` was snapshotted/serialized but NEVER
// read by any kernel input (the "dead parameter system", §3.3). These tests prove
// a feature's `exprs` now resolve against `doc.params` at rebuild entry, so one
// global parameter drives feature dimensions — and editing it re-drives the build.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, mm, type Occt } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("R6 — doc.params drives features through exprs", () => {
  it("a global param drives a box dimension via an expression", () => {
    const doc = (width: number): CadDocument => ({
      features: [
        {
          id: "f1",
          type: "box",
          params: { dx: 0, dy: 0, dz: mm(10) },
          exprs: { dx: "width", dy: "width * 2" },
        },
      ],
      params: { width },
    });

    const a = rebuildDocument(oc, doc(mm(20)))!;
    // dx=0.02, dy=0.04, dz=0.01 → 8e-6 m³
    expect(a.volume()).toBeCloseTo(mm(20) * mm(40) * mm(10), 9);
    a.delete();

    // Editing the ONE global param re-drives the whole build (the point of R6).
    const b = rebuildDocument(oc, doc(mm(30)))!;
    expect(b.volume()).toBeCloseTo(mm(30) * mm(60) * mm(10), 9);
    b.delete();
  });

  it("one param drives TWO features (single source of truth)", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: 0, dy: mm(10), dz: mm(10) }, exprs: { dx: "s" } },
        {
          id: "f2",
          type: "box",
          params: { ox: 0, dx: 0, dy: mm(10), dz: mm(10) },
          exprs: { ox: "s", dx: "s" },
          data: { op: "new" },
        },
      ],
      params: { s: mm(20) },
    };
    const solid = rebuildDocument(oc, doc)!;
    // Both boxes are s(=20mm) wide; f2 offset by s in x (separate body). Total
    // volume = 2 × (0.02 × 0.01 × 0.01) = 4e-6.
    expect(solid.volume()).toBeCloseTo(2 * mm(20) * mm(10) * mm(10), 9);
    solid.delete();
  });

  it("a bad expression fails LOUDLY as a feature error (fail-fast rebuild)", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "box", params: { dx: mm(10), dy: mm(10), dz: mm(10) }, exprs: { dx: "unknownParam + 1" } }],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/unknownParam|parameter/i);
  });
});
