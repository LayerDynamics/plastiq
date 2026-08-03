// patternAlongPath — real OCCT: uniform arc-length samples on a polyline spine;
// first copy at path start, last at path end (FablesFindings §13.2).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import type { SpinePath } from "../sketch/spine.js";
import { patternAlongPath } from "./pattern.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Straight polyline along +X from the origin, length `len` (SI metres). */
function lineSpine(len: number): SpinePath {
  return { kind: "polyline", points: [[0, 0, 0], [len, 0, 0]] };
}

describe("patternAlongPath", () => {
  it("places N copies at equal arc-length samples — first at start, last at end", () => {
    const L = mm(100);
    const box = makeBox(oc, mm(5), mm(5), mm(5));
    const n = 5;
    const copies = patternAlongPath(oc, box, lineSpine(L), n);
    expect(copies).toHaveLength(n);

    // Origin of the base is at (0,0,0); each copy is translated to sample i.
    // Uniform samples on [0, L]: i * L / (n − 1).
    for (let i = 0; i < n; i++) {
      const expected = (i * L) / (n - 1);
      const com = copies[i]!.centreOfMass();
      // Base box COM is at half-extents; after pure translate, COM.x = half + sample.
      expect(com[0]).toBeCloseTo(mm(2.5) + expected, 6);
      expect(com[1]).toBeCloseTo(mm(2.5), 6);
      expect(com[2]).toBeCloseTo(mm(2.5), 6);
      expect(copies[i]!.volume()).toBeCloseTo(box.volume(), 12);
    }

    // Explicit end-point pins: first sample at 0, last at L.
    expect(copies[0]!.centreOfMass()[0]).toBeCloseTo(mm(2.5), 6);
    expect(copies[n - 1]!.centreOfMass()[0]).toBeCloseTo(mm(2.5) + L, 6);

    for (const c of copies) c.delete();
    box.delete();
  });

  it("samples a multi-segment polyline by total arc length (not per segment)", () => {
    // L-shaped path: 60 mm +X then 40 mm +Y → total 100 mm.
    const path: SpinePath = {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [mm(60), 0, 0],
        [mm(60), mm(40), 0],
      ],
    };
    const box = makeBox(oc, mm(4), mm(4), mm(4));
    const copies = patternAlongPath(oc, box, path, 3);
    expect(copies).toHaveLength(3);

    const half = mm(2);
    // Samples at s = 0, 50, 100 mm along the path.
    // s=0 → (0,0); s=50 → still on first leg → (50, 0); s=100 → end → (60, 40).
    expect(copies[0]!.centreOfMass()[0]).toBeCloseTo(half, 5);
    expect(copies[0]!.centreOfMass()[1]).toBeCloseTo(half, 5);

    expect(copies[1]!.centreOfMass()[0]).toBeCloseTo(half + mm(50), 5);
    expect(copies[1]!.centreOfMass()[1]).toBeCloseTo(half, 5);

    expect(copies[2]!.centreOfMass()[0]).toBeCloseTo(half + mm(60), 5);
    expect(copies[2]!.centreOfMass()[1]).toBeCloseTo(half + mm(40), 5);

    for (const c of copies) c.delete();
    box.delete();
  });

  it("align=true rotates local +X onto the path tangent", () => {
    // Path along +Y: without align, the box's long axis stays +X; with align,
    // local +X follows +Y so the long extent lies along Y.
    const path: SpinePath = {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0, mm(80), 0],
      ],
    };
    // Thin stick along local +X: 20 × 2 × 2 mm.
    const stick = makeBox(oc, mm(20), mm(2), mm(2));
    const aligned = patternAlongPath(oc, stick, path, 2, { align: true });
    expect(aligned).toHaveLength(2);

    // At the start: rotation maps +X → +Y, then translate to origin.
    // Stick extents [0,20]×[0,2]×[0,2] → after R(+90° about Z) about origin:
    // (x,y,z) → (−y, x, z) so bbox roughly x∈[−2,0], y∈[0,20].
    const bb0 = aligned[0]!.boundingBox();
    expect(bb0.max[1] - bb0.min[1]).toBeCloseTo(mm(20), 5);
    expect(bb0.max[0] - bb0.min[0]).toBeCloseTo(mm(2), 5);

    for (const c of aligned) c.delete();
    stick.delete();
  });

  it("rejects a pathologically large count", () => {
    const box = makeBox(oc, mm(1), mm(1), mm(1));
    expect(() => patternAlongPath(oc, box, lineSpine(mm(10)), 1_000_000)).toThrow(
      /exceeds the maximum/,
    );
    expect(() => patternAlongPath(oc, box, lineSpine(mm(10)), 0)).toThrow(/count must be/);
    box.delete();
  });

  it("count === 1 places a single copy at the path start", () => {
    const box = makeBox(oc, mm(6), mm(6), mm(6));
    const copies = patternAlongPath(oc, box, lineSpine(mm(50)), 1);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.centreOfMass()[0]).toBeCloseTo(mm(3), 6);
    copies[0]!.delete();
    box.delete();
  });
});
