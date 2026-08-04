// §14 trimSurface — keep one side of a plane split (real OCCT).

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { offsetPlane, planeYZ } from "../env/plane.js";
import { trimSurface } from "./surface.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("trimSurface (§14)", () => {
  it("keeps the positive half of a box cut by a mid-plane", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const full = box.volume();
    // Mid-plane parallel to YZ through x = 20 mm.
    const plane = offsetPlane(planeYZ(), mm(20));
    const kept = trimSurface(oc, box, plane, { keep: "positive" });
    try {
      expect(kept.volume()).toBeCloseTo(full / 2, 7);
      expect(kept.volume()).toBeGreaterThan(0);
      expect(kept.isValid()).toBe(true);
      // COM should be on the +X side of the cut.
      expect(kept.centreOfMass()[0]).toBeGreaterThan(mm(20));
    } finally {
      kept.delete();
      box.delete();
    }
  });

  it("keep:negative retains the other half", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const plane = offsetPlane(planeYZ(), mm(20));
    const pos = trimSurface(oc, box, plane, { keep: "positive" });
    const neg = trimSurface(oc, box, plane, { keep: "negative" });
    try {
      expect(pos.volume() + neg.volume()).toBeCloseTo(box.volume(), 6);
      expect(neg.centreOfMass()[0]).toBeLessThan(mm(20));
    } finally {
      pos.delete();
      neg.delete();
      box.delete();
    }
  });
});
