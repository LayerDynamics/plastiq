// R4 (chunk 3) — loft, sweep, patterns, extrude-to-face against the real wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { offsetPlane, planeXY } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { FaceRef } from "../mesh/tagged.js";
import { circularPattern, extrudeToFace, linearPattern, loft, sweep, union } from "./index.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function square(half: number, z: number): Sketch {
  const sk = new Sketch(offsetPlane(planeXY(), z));
  sk.lineTo(-half, -half);
  sk.lineTo(half, -half);
  sk.lineTo(half, half);
  sk.lineTo(-half, half);
  return sk;
}

describe("loft", () => {
  it("lofts a square frustum with the expected (Prismatoid) volume", () => {
    const solid = loft(oc, [square(mm(20), 0), square(mm(10), mm(50))], { ruled: true });
    // Frustum V = h/3·(A1 + A2 + √(A1·A2))
    const a1 = mm(40) ** 2;
    const a2 = mm(20) ** 2;
    const expected = (mm(50) / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
    expect(solid.volume()).toBeCloseTo(expected, 8);
    solid.delete();
  });
});

describe("sweep", () => {
  it("sweeps a circle along a straight spine into a cylinder", () => {
    const profile = Sketch.circle(planeXY(), 0, 0, mm(10));
    const solid = sweep(oc, profile, {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0, 0, mm(100)],
      ],
    });
    expect(solid.volume()).toBeCloseTo(Math.PI * mm(10) ** 2 * mm(100), 8);
    solid.delete();
  });
});

describe("linearPattern", () => {
  it("makes N non-overlapping copies that fuse to N× the volume", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const copies = linearPattern(oc, box, [1, 0, 0], mm(20), 3);
    expect(copies).toHaveLength(3);
    let acc = copies[0]!;
    for (let i = 1; i < copies.length; i++) {
      const r = union(oc, acc, copies[i]!);
      expect(r.ok).toBe(true);
      if (r.ok) acc = r.solid;
    }
    expect(acc.volume()).toBeCloseTo(3 * box.volume(), 9);
    for (const c of copies) c.delete();
    acc.delete();
    box.delete();
  });
});

describe("circularPattern", () => {
  it("makes N volume-preserving copies at distinct positions", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const copies = circularPattern(oc, box, [0, 0, 0], [0, 0, 1], 4, Math.PI * 2);
    expect(copies).toHaveLength(4);
    for (const c of copies) expect(c.volume()).toBeCloseTo(box.volume(), 12);
    // The 2nd copy (90° turn) must sit at a different bbox than the first.
    expect(copies[1]!.boundingBox().min[0]).not.toBeCloseTo(copies[0]!.boundingBox().min[0], 6);
    for (const c of copies) c.delete();
    box.delete();
  });

  it("over a PARTIAL angle the last copy sits AT the full angle (endpoint-inclusive)", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30)); // occupies [0,60]×[0,40]×[0,30]
    // 4 copies over a half-turn (π). With the endpoint-inclusive convention the
    // copies sit at 0, π/3, 2π/3, π — the LAST one at exactly π. The old
    // angle/count behavior would have left it at 3π/4 (under-filling the arc).
    const copies = circularPattern(oc, box, [0, 0, 0], [0, 0, 1], 4, Math.PI);
    expect(copies).toHaveLength(4);
    // i=0 is the un-rotated base.
    expect(copies[0]!.boundingBox().min[0]).toBeCloseTo(0, 6);
    expect(copies[0]!.boundingBox().max[0]).toBeCloseTo(mm(60), 6);
    // i=3 is rotated π about +Z through the origin: (x,y) → (−x,−y), so the box
    // maps to [−60,0]×[−40,0]. A copy at 3π/4 would NOT produce this bbox.
    const last = copies[3]!.boundingBox();
    expect(last.min[0]).toBeCloseTo(-mm(60), 6);
    expect(last.max[0]).toBeCloseTo(0, 6);
    expect(last.min[1]).toBeCloseTo(-mm(40), 6);
    expect(last.max[1]).toBeCloseTo(0, 6);
    for (const c of copies) c.delete();
    box.delete();
  });
});

describe("extrudeToFace", () => {
  it("pads a sketch from its plane up to the picked top face", () => {
    const base = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, base);
    const top: FaceRef = {
      normal: mesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!.normal,
    };
    const sk = new Sketch(planeXY());
    sk.lineTo(0, 0);
    sk.lineTo(mm(20), 0);
    sk.lineTo(mm(20), mm(20));
    sk.lineTo(0, mm(20));
    const pad = extrudeToFace(oc, sk, base, top);
    // 20×20 pad from z=0 up to the top face at z=30mm.
    expect(pad.volume()).toBeCloseTo(mm(20) * mm(20) * mm(30), 9);
    expect(pad.boundingBox().max[2]).toBeCloseTo(mm(30), 6);
    base.delete();
    pad.delete();
  });

  it("fails loudly on a non-perpendicular target that cannot terminate the pad (T3)", () => {
    // Target a SIDE face (+X), whose normal is perpendicular to the +Z extrude
    // direction — the face is parallel to the extrude, so no pad can terminate
    // on it. The old centroid-projection approximation silently padded to the
    // centroid's projected depth (mid-height, 15mm); the true up-to-face trim
    // rejects it instead of fabricating geometry. (Angled/curved targets that CAN
    // terminate the pad are covered exactly in extrudeToFace.test.ts.)
    const base = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, base);
    const side = mesh.faceGroups.find((g) => Math.round(g.normal[0]) === 1)!;
    const sideRef: FaceRef = { normal: side.normal, centroid: side.centroid };
    const sk = new Sketch(planeXY());
    sk.lineTo(0, 0);
    sk.lineTo(mm(20), 0);
    sk.lineTo(mm(20), mm(20));
    sk.lineTo(0, mm(20));
    expect(() => extrudeToFace(oc, sk, base, sideRef)).toThrow(/cannot terminate the extrude/);
    base.delete();
  });
});
