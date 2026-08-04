// §13.2/§14 — the `thicken` FEATURE (kernel op wired through the rebuild evaluator).
// Kernel analytic volume is proven in packages/cad's thicken.test.ts; here we prove
// the FEATURE dispatches: params.thickness + data.bothSides → thicken() → solid plate.

import { beforeAll, describe, expect, it } from "vitest";
import { exportStep, initOcct, makeBox, mm, Solid, type Occt } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import type { TopAbs_ShapeEnum } from "opencascade.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** First face of a box, as a STEP payload of a single-face "sheet" body. */
function faceStep(dx: number, dy: number, dz: number): string {
  const box = makeBox(oc, dx, dy, dz);
  try {
    // embind types the enum object loosely — cast like rebuild.test.ts bodyCount.
    const S = oc.TopAbs_ShapeEnum as unknown as {
      TopAbs_FACE: TopAbs_ShapeEnum;
      TopAbs_SHAPE: TopAbs_ShapeEnum;
    };
    const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    const face = oc.TopoDS.Face_1(exp.Current());
    exp.delete();
    const sheet = new Solid(oc, face);
    try {
      return exportStep(oc, sheet);
    } finally {
      sheet.delete();
    }
  } finally {
    box.delete();
  }
}

describe("§13.2 thicken feature — dispatches through rebuild to the kernel op", () => {
  it("thickens an imported planar face into a plate of area × thickness", () => {
    // Any rectangular face of a 40×30×20 mm box; thickness 5 mm.
    // Which face STEP enumeration returns first is not guaranteed — measure the
    // imported sheet's surface area and assert volume = area × thickness.
    const step = faceStep(mm(40), mm(30), mm(20));
    const t = mm(5);
    const sheetOnly: CadDocument = {
      features: [{ id: "f1", type: "importStep", data: { step } }],
      params: {},
    };
    const sheet = rebuildDocument(oc, sheetOnly)!;
    let faceArea: number;
    try {
      // Sheet has zero volume; surface area is the face area we thicken.
      const props = new oc.GProp_GProps_1();
      try {
        oc.BRepGProp.SurfaceProperties_1(sheet.shape, props, false, false);
        faceArea = props.Mass();
      } finally {
        props.delete();
      }
      expect(faceArea).toBeGreaterThan(0);
    } finally {
      sheet.delete();
    }
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "importStep", data: { step } },
        {
          id: "f2",
          type: "thicken",
          params: { thickness: t },
          data: { bothSides: false },
        },
      ],
      params: {},
    };
    const plate = rebuildDocument(oc, doc)!;
    try {
      expect(plate.volume()).toBeCloseTo(faceArea * t, 10);
      expect(plate.volume()).toBeGreaterThan(0);
      expect(plate.isValid()).toBe(true);
    } finally {
      plate.delete();
    }
  });

  it("zero thickness fails loudly at rebuild", () => {
    const step = faceStep(mm(20), mm(20), mm(10));
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "importStep", data: { step } },
        { id: "f2", type: "thicken", params: { thickness: 0 } },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/thickness/i);
  });
});
