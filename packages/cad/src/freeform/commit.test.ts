// §15 Lane A(b) — freeform → B-rep face commit (sample + surfaceFromPoints).

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { planeSurface } from "./generators.js";
import { moveControlPoint } from "./ops.js";
import { freeformToFace } from "./commit.js";
import { surfaceArea } from "../action/surface.js";
import { shapeEnums } from "../mesh/normals.js";
import { exportStep, importStep } from "../io/index.js";
import { Solid } from "../solid/solid.js";
import { evaluate } from "./deBoor.js";

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

  it("preserves a dragged control net through STEP within the fitting tolerance", () => {
    const base = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], mm(40), mm(30));
    const edited = moveControlPoint(base, 1, 1, [mm(40), mm(30), mm(8)]);
    const committed = freeformToFace(oc, edited, {
      samplesU: 24,
      samplesV: 24,
      tolerance: 1e-6,
    });
    const imported = importStep(oc, exportStep(oc, committed));
    let maxDeviation = 0;
    try {
      for (const u of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        for (const v of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
          const p = evaluate(edited, u, v);
          const gp = new oc.gp_Pnt_3(p[0], p[1], p[2]);
          const maker = new oc.BRepBuilderAPI_MakeVertex(gp);
          const point = new Solid(oc, maker.Vertex());
          try {
            maxDeviation = Math.max(maxDeviation, imported.distanceTo(point).distance);
          } finally {
            point.delete();
            maker.delete();
            gp.delete();
          }
        }
      }
      expect(committed.isValid()).toBe(true);
      expect(imported.isValid()).toBe(true);
      expect(maxDeviation).toBeLessThanOrEqual(1e-6);
    } finally {
      imported.delete();
      committed.delete();
    }
  });
});
