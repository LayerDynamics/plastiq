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
import { makeBox, makeCone, makeCylinder, makeSphere, makeTorus } from "../solid/primitives.js";
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

  it("binds ShapeUpgrade_UnifySameDomain — and it CONSTRUCTS (§2.2 boolean robustness)", () => {
    // `typeof oc.X === "function"` is NOT proof: embind exposes the constructor
    // for an under-listed class and only throws UnboundTypeError when it is
    // actually called. This test used to assert only the typeof for
    // BOPAlgo_ArgumentAnalyzer and PASSED while `new` threw — false assurance of
    // exactly the kind this file exists to prevent. So: construct it.
    expect(typeof oc.ShapeUpgrade_UnifySameDomain_2).toBe("function");
    const box = makeBox(oc, 0.01, 0.01, 0.01);
    const usd = new oc.ShapeUpgrade_UnifySameDomain_2(box.shape, true, true, false);
    usd.SetSafeInputMode(true);
    usd.Build();
    const merged = usd.Shape();
    expect(merged.IsNull()).toBe(false);
    merged.delete();
    usd.delete();
    box.delete();
  });

  /**
   * §2.2's ArgumentAnalyzer pre-check is IMPOSSIBLE through this build, and this
   * records why so it is not attempted again as a silent no-op.
   *
   * The class needed its whole base chain (BOPAlgo_Algo → BOPAlgo_Options) added
   * to occt.build.yml before `new` stopped throwing UnboundTypeError. But OCCT
   * exposes each check mode as `Standard_Boolean&` (C++ callers write
   * `analyzer.SelfInterMode() = Standard_True`), and embind degrades a
   * reference-returning accessor to a READ-ONLY getter: the only setters bound
   * are SetShape1/SetShape2. Since OCCT defaults EVERY mode to false, a
   * `Perform()` here would analyse nothing and cheerfully report no faults —
   * strictly worse than no pre-check, because it looks like validation.
   */
  it("BOPAlgo_ArgumentAnalyzer constructs but has NO mode setters — the pre-check cannot work", () => {
    const an = new oc.BOPAlgo_ArgumentAnalyzer();
    try {
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(an));
      // Shapes can be set; the check MODES cannot.
      expect(proto).toContain("SetShape1");
      expect(proto.filter((p) => /^Set.*Mode$/.test(p))).toEqual([]);
      // And every mode is off by default, so Perform() would check nothing.
      expect(an.SelfInterMode()).toBe(false);
      expect(an.ArgumentTypeMode()).toBe(false);
    } finally {
      an.delete();
    }
  });

  it("binds the round primitives' full base chain (§4.11 — round geometry without a sketcher)", () => {
    // BRepPrimAPI_MakeCylinder/Sphere/Cone/Torus all derive from
    // BRepPrimAPI_MakeOneAxis; listing the leaf class alone still throws
    // "UnboundTypeError: … unbound types: 23BRepPrimAPI_MakeOneAxis" on `new`.
    const c = makeCylinder(oc, 0.01, 0.02);
    expect(c.volume()).toBeCloseTo(Math.PI * 1e-4 * 0.02, 12);
    c.delete();
    const s = makeSphere(oc, 0.01);
    expect(s.volume()).toBeCloseTo((4 / 3) * Math.PI * 1e-6, 12);
    s.delete();
    const k = makeCone(oc, 0.01, 0.005, 0.02);
    expect(k.volume()).toBeGreaterThan(0);
    k.delete();
    const t = makeTorus(oc, 0.02, 0.005);
    expect(t.volume()).toBeCloseTo(2 * Math.PI ** 2 * 0.02 * 0.005 ** 2, 12);
    t.delete();
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
