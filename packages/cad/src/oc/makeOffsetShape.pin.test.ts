// Binding pin for BRepOffsetAPI_MakeOffsetShape and the thicken (§13.2) route,
// verified against the real trimmed wasm (per occt.build.yml's rule: a class can
// be DECLARED in the .d.ts yet throw "not a constructor" / an embind
// UnboundTypeError only when first `new`-ed — see oc/bindings.test.ts).
//
// This file pins THREE measured facts the thicken op (action/thicken.ts) rests on:
//   1. `BRepOffsetAPI_MakeOffsetShape` is CONSTRUCTIBLE in this build.
//   2. Its `PerformByJoin` is a NON-thickening offset: on a bare face it returns
//      only the offset SKIN (a zero-volume shell) — so it is NOT the thicken
//      route, despite §13.2 first proposing it.
//   3. `BRepOffsetAPI_MakeThickSolid.MakeThickSolidBySimple(face, offset)` DOES
//      thicken a face into a valid closed SOLID of volume ≈ area × |offset|, and a
//      negative-signed result is fixed by TopoDS_Shape.Reversed(). This is the
//      route action/thicken.ts uses.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "./init.js";
import { makeBox } from "../solid/primitives.js";
import { shapeEnums } from "../mesh/normals.js";
import type { TopoDS_Face, TopoDS_Shape } from "opencascade.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
});

function firstFace(): { face: TopoDS_Face; area: number; box: { delete(): void } } {
  const box = makeBox(oc, 0.04, 0.03, 0.02);
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  const face = oc.TopoDS.Face_1(exp.Current());
  exp.delete();
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const area = props.Mass();
  props.delete();
  return { face, area, box };
}

function volumeOf(shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

describe("MakeOffsetShape / thicken binding pin (§13.2)", () => {
  it("BRepOffsetAPI_MakeOffsetShape is bound AND constructs", () => {
    expect(typeof oc.BRepOffsetAPI_MakeOffsetShape).toBe("function");
    // typeof is NOT proof under embind (bindings.test.ts:43-48). Construct it.
    const maker = new oc.BRepOffsetAPI_MakeOffsetShape();
    expect(maker).toBeDefined();
    maker.delete();
  });

  it("PerformByJoin is a non-thickening offset — on a face it yields a zero-volume SKIN", () => {
    const { face, box } = firstFace();
    const S = shapeEnums(oc);
    const maker = new oc.BRepOffsetAPI_MakeOffsetShape();
    const progress = new oc.Message_ProgressRange_1();
    try {
      maker.PerformByJoin(
        face,
        0.005,
        1e-5,
        oc.BRepOffset_Mode.BRepOffset_Skin as never,
        false,
        false,
        oc.GeomAbs_JoinType.GeomAbs_Arc as never,
        false,
        progress,
      );
      expect(maker.IsDone()).toBe(true);
      const shape = maker.Shape();
      expect(shape.IsNull()).toBe(false);
      // The result is a SHELL (an offset surface), not a SOLID — and a shell has no
      // enclosed volume. This is exactly why PerformByJoin cannot be the thicken
      // route: it never produces a solid plate.
      expect(shape.ShapeType()).toBe(S.TopAbs_SHELL);
      expect(volumeOf(shape)).toBeCloseTo(0, 12);
      shape.delete();
    } finally {
      progress.delete();
      maker.delete();
      face.delete();
      box.delete();
    }
  });

  it("MakeThickSolidBySimple thickens a face into a valid SOLID of volume area×|offset| (thicken's route)", () => {
    const { face, area, box } = firstFace();
    const S = shapeEnums(oc);
    const t = 0.005;
    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      maker.MakeThickSolidBySimple(face, t);
      expect(maker.IsDone()).toBe(true);
      const shape = maker.Shape();
      expect(shape.IsNull()).toBe(false);
      // A real closed SOLID, not a skin.
      expect(shape.ShapeType()).toBe(S.TopAbs_SOLID);
      const analyzer = new oc.BRepCheck_Analyzer(shape, true, false);
      expect(analyzer.IsValid_2()).toBe(true);
      analyzer.delete();
      // Its magnitude is the analytic plate volume; the SIGN depends on the input
      // face's orientation. TopoDS_Shape.Reversed() flips the sign while keeping
      // the same (valid) geometry — the normalization action/thicken.ts performs.
      const signed = volumeOf(shape);
      expect(Math.abs(signed)).toBeCloseTo(area * t, 12);
      const reversed = shape.Reversed();
      expect(volumeOf(reversed)).toBeCloseTo(-signed, 12);
      const revAnalyzer = new oc.BRepCheck_Analyzer(reversed, true, false);
      expect(revAnalyzer.IsValid_2()).toBe(true);
      revAnalyzer.delete();
      reversed.delete();
      shape.delete();
    } finally {
      maker.delete();
      face.delete();
      box.delete();
    }
  });
});
