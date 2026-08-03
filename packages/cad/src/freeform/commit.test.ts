// §15 Lane A(b) — freeform → B-rep face commit (sample + surfaceFromPoints).

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { planeSurface } from "./generators.js";
import { freeformToFace } from "./commit.js";
import { surfaceArea } from "../action/surface.js";
import { shapeEnums } from "../mesh/normals.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("freeformToFace — §15 commit path", () => {
  it("commits a planar freeform square to a B-rep face of the same area", () => {
    const surf = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], mm(40), mm(30));
    const face = freeformToFace(oc, surf, { samplesU: 8, samplesV: 8 });
    try {
      const S = shapeEnums(oc);
      expect(face.shape.ShapeType()).toBe(S.TopAbs_FACE);
      const area = surfaceArea(oc, face);
      const expected = mm(40) * mm(30);
      // Fitting a plane through an 8×8 sample grid recovers the exact area within
      // a small absolute tolerance (GeomAPI fit + MakeFace UV bounds).
      expect(area).toBeCloseTo(expected, 4);
      expect(face.isValid()).toBe(true);
      expect(Math.abs(face.volume())).toBeLessThan(1e-9);
    } finally {
      face.delete();
    }
  });

  it("rejects too-few samples loudly", () => {
    const surf = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], 1, 1);
    expect(() => freeformToFace(oc, surf, { samplesU: 1, samplesV: 8 })).toThrow(/samples/);
  });
});
