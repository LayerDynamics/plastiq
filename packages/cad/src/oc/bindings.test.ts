// Binding guard for the OCCT symbols the kernel depends on but does not call on
// every code path (§2.1 / §2.2 / I1 / §2.5).
//
// The shipped wasm is a TRIMMED opencascade.js build: only the classes listed in
// `occt.build.yml` exist at runtime. Under-listing compiles fine and throws
// "oc.X is not a constructor" / an embind UnboundTypeError only when the code
// path is first hit — which is exactly how a missing class survives a green
// suite. These classes were absent from the trim until the 2026-07-17 rebuild;
// this test fails loudly if a future re-trim drops them again.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "./init.js";
import { makeBox } from "../solid/primitives.js";
import { shapeEnums } from "../mesh/normals.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
});

describe("trimmed-wasm bindings the kernel requires", () => {
  it("binds BRepAdaptor_Surface + the gp_ surface types (§2.1 per-surface-type FaceRefs)", () => {
    // A face's persistent signature is derived from its ACTUAL surface via
    // GetType(); without these a closed curved face can only be described by its
    // (degenerate) average triangulation normal.
    expect(typeof oc.BRepAdaptor_Surface_2).toBe("function");
    expect(typeof oc.gp_Cylinder_1).toBe("function");
    expect(typeof oc.gp_Cone_1).toBe("function");
    expect(typeof oc.gp_Sphere_1).toBe("function");
    expect(typeof oc.gp_Torus_1).toBe("function");
    // The enum GetType() returns, read as oc.GeomAbs_SurfaceType.<Member>.
    expect(oc.GeomAbs_SurfaceType.GeomAbs_Plane).toBeDefined();
    expect(oc.GeomAbs_SurfaceType.GeomAbs_Cylinder).toBeDefined();
    expect(oc.GeomAbs_SurfaceType.GeomAbs_Sphere).toBeDefined();
    expect(oc.GeomAbs_SurfaceType.GeomAbs_Cone).toBeDefined();
    expect(oc.GeomAbs_SurfaceType.GeomAbs_Torus).toBeDefined();
  });

  it("binds ShapeUpgrade_UnifySameDomain + BOPAlgo_ArgumentAnalyzer (§2.2 boolean robustness)", () => {
    expect(typeof oc.ShapeUpgrade_UnifySameDomain_2).toBe("function");
    expect(typeof oc.BOPAlgo_ArgumentAnalyzer).toBe("function");
  });

  /**
   * I1 (STEP/IGES units) CANNOT be fixed through Interface_Static in this build.
   *
   * The class binds, but embind exposes NO statics on it — its only own
   * properties are `length|name|prototype`, so `Interface_Static.SetCVal(...)`
   * (how OCCT's "write.step.unit" / "xstep.cascade.unit" are normally set) does
   * not exist at runtime. This test PINS that fact so the unit fix is not
   * "corrected" back to a call that silently does nothing. The units are instead
   * handled by scaling at the interchange boundary (io/index.ts), which needs no
   * OCCT static config and is directly testable.
   */
  it("exposes NO statics on Interface_Static — I1 must scale, not configure", () => {
    expect(typeof oc.Interface_Static).toBe("function");
    const statics = Object.getOwnPropertyNames(oc.Interface_Static);
    expect(statics).not.toContain("SetCVal");
    expect(statics).not.toContain("CVal");
  });

  it("classifies a real face through BRepAdaptor_Surface.GetType() (the §2.1 keystone)", () => {
    // The mechanism §2.1's fix rests on: ask the ACTUAL surface what it is and
    // read its analytic parameters, instead of inferring identity from an
    // averaged triangulation normal (which is degenerate on closed curved faces).
    const box = makeBox(oc, 0.04, 0.03, 0.02);
    const S = shapeEnums(oc);
    const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    let planes = 0;
    while (exp.More()) {
      const face = oc.TopoDS.Face_1(exp.Current());
      const ad = new oc.BRepAdaptor_Surface_2(face, true);
      if (ad.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        const pl = ad.Plane();
        const ax = pl.Axis();
        const dir = ax.Direction();
        // Every box face is axis-aligned: exactly one component is ±1.
        const comps = [Math.abs(dir.X()), Math.abs(dir.Y()), Math.abs(dir.Z())];
        expect(comps.filter((c) => Math.abs(c - 1) < 1e-9)).toHaveLength(1);
        planes++;
        dir.delete();
        ax.delete();
        pl.delete();
      }
      ad.delete();
      face.delete();
      exp.Next();
    }
    exp.delete();
    box.delete();
    expect(planes, "a box has six planar faces").toBe(6);
  });
});
