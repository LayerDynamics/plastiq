import { beforeAll, describe, expect, it } from "vitest";

import { planeXY } from "../env/plane.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { initOcct, type Occt } from "../oc/init.js";
import { Sketch } from "../sketch/sketch.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { linearForm, nativePrism } from "./extrude.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("native local prism / linear form (§13.2)", () => {
  it("joins a straight BRepFeat prism on a resolved support face and returns history", () => {
    const base = makeBox(oc, mm(40), mm(40), mm(20));
    const top = tessellateTagged(oc, base, { linearDeflection: mm(0.5) }).faceGroups.find(
      (face) => Math.round(face.normal[2]) === 1,
    )!;
    const sketch = Sketch.circle({ ...planeXY(), origin: [0, 0, mm(20)] }, mm(20), mm(20), mm(5));
    const result = nativePrism(oc, base, sketch, { support: top, length: mm(10) });
    try {
      expect(result.solid.isValid()).toBe(true);
      expect(result.solid.volume()).toBeCloseTo(base.volume() + Math.PI * mm(5) ** 2 * mm(10), 10);
      expect(result.history.IsRemoved(base.shape)).toBe(false);
    } finally {
      result.history.delete();
      result.solid.delete();
      base.delete();
    }
  });

  it("LocOpe_LinearForm produces the exact closed-profile rib volume", () => {
    const sketch = Sketch.circle(planeXY(), 0, 0, mm(4));
    const rib = linearForm(oc, sketch, mm(12));
    try {
      expect(rib.isValid()).toBe(true);
      expect(rib.volume()).toBeCloseTo(Math.PI * mm(4) ** 2 * mm(12), 10);
    } finally {
      rib.delete();
    }
  });

  it("constructs a drafted BRepFeat boss and a straight native pocket", () => {
    const base = makeBox(oc, mm(40), mm(40), mm(20));
    const top = tessellateTagged(oc, base, { linearDeflection: mm(0.5) }).faceGroups.find(
      (face) => Math.round(face.normal[2]) === 1,
    )!;
    const sketch = Sketch.circle({ ...planeXY(), origin: [0, 0, mm(20)] }, mm(20), mm(20), mm(5));
    const drafted = nativePrism(oc, base, sketch, {
      support: top,
      length: mm(10),
      draftAngle: (5 * Math.PI) / 180,
    });
    const pocket = nativePrism(oc, base, sketch, {
      support: top,
      length: mm(10),
      op: "cut",
      direction: [0, 0, -1],
    });
    try {
      expect(drafted.solid.isValid()).toBe(true);
      expect(drafted.solid.volume()).toBeGreaterThan(base.volume());
      // A non-zero draft cannot have the straight-cylinder volume.
      expect(drafted.solid.volume()).not.toBeCloseTo(
        base.volume() + Math.PI * mm(5) ** 2 * mm(10),
        10,
      );
      expect(pocket.solid.isValid()).toBe(true);
      expect(pocket.solid.volume()).toBeCloseTo(base.volume() - Math.PI * mm(5) ** 2 * mm(10), 10);
    } finally {
      pocket.history.delete();
      pocket.solid.delete();
      drafted.history.delete();
      drafted.solid.delete();
      base.delete();
    }
  });

  it("terminates a native pocket at a resolved face without overshoot/trim emulation", () => {
    const base = makeBox(oc, mm(40), mm(40), mm(20));
    const faces = tessellateTagged(oc, base, { linearDeflection: mm(0.5) }).faceGroups;
    const top = faces.find((face) => Math.round(face.normal[2]) === 1)!;
    const bottom = faces.find((face) => Math.round(face.normal[2]) === -1)!;
    const sketch = Sketch.circle({ ...planeXY(), origin: [0, 0, mm(20)] }, mm(20), mm(20), mm(5));
    const through = nativePrism(oc, base, sketch, {
      support: top,
      until: bottom,
      op: "cut",
      direction: [0, 0, -1],
    });
    try {
      expect(through.solid.isValid()).toBe(true);
      expect(through.solid.volume()).toBeCloseTo(base.volume() - Math.PI * mm(5) ** 2 * mm(20), 10);
    } finally {
      through.history.delete();
      through.solid.delete();
      base.delete();
    }
  });
});
