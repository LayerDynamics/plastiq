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
import { transformRigid, translate } from "../action/transform.js";
import { Solid } from "../solid/solid.js";
import { describeOcctError, isRawOcctFailure } from "./error.js";
import { massProperties } from "../lower/massprops.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
});

describe("trimmed-wasm bindings the kernel requires", () => {
  it("binds the native local-form and exact-distance surface (§13.2)", () => {
    expect(typeof oc.BRepFeat_Form).toBe("function");
    expect(typeof oc.BRepFeat_MakePrism_2).toBe("function");
    expect(typeof oc.BRepFeat_MakeDPrism_1).toBe("function");
    expect(typeof oc.LocOpe_LinearForm_2).toBe("function");
    expect(typeof oc.BRepExtrema_DistShapeShape_1).toBe("function");
    expect(typeof oc.BRepBuilderAPI_MakeVertex).toBe("function");

    // Construct and perform the exact-distance class: typeof alone does not
    // detect an omitted embind base/argument type.
    const a = makeBox(oc, 0.01, 0.01, 0.01);
    const b = translate(oc, a, [0.02, 0, 0]);
    try {
      expect(a.distanceTo(b).distance).toBeCloseTo(0.01, 10);
    } finally {
      b.delete();
      a.delete();
    }
  });

  it("binds and constructs exact ellipse edges (§13.3)", () => {
    expect(typeof oc.gp_Elips_2).toBe("function");
    expect(typeof oc.BRepBuilderAPI_MakeEdge_12).toBe("function");

    const center = new oc.gp_Pnt_3(0, 0, 0);
    const normal = new oc.gp_Dir_4(0, 0, 1);
    const majorDirection = new oc.gp_Dir_4(1, 0, 0);
    const axes = new oc.gp_Ax2_2(center, normal, majorDirection);
    const ellipse = new oc.gp_Elips_2(axes, 0.02, 0.01);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_12(ellipse);
    const edge = edgeMaker.Edge();
    try {
      expect(edgeMaker.IsDone()).toBe(true);
      expect(edge.IsNull()).toBe(false);
      expect(ellipse.MajorRadius()).toBeCloseTo(0.02, 12);
      expect(ellipse.MinorRadius()).toBeCloseTo(0.01, 12);
    } finally {
      edge.delete();
      edgeMaker.delete();
      ellipse.delete();
      axes.delete();
      majorDirection.delete();
      normal.delete();
      center.delete();
    }
  });

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

  it("binds the bounded-surface extension contract (§14 untrim/extend)", () => {
    expect(typeof oc.Handle_Geom_BoundedSurface_2).toBe("function");
    expect(typeof oc.GeomLib.ExtendSurfByLength).toBe("function");
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

  /**
   * §2.11.2 — the multi-body + quaternion surface. All three were MISSING from
   * the trim until the 2026-07-18 rebuild: `gp_Quaternion` and `TopoDS_Compound`
   * existed only as parameter/return TYPES (no constructor), and the builder that
   * fills a compound was absent entirely, so gp_Trsf's whole quaternion API was
   * unreachable and a multi-body shape could not be assembled at all.
   *
   * NOTE this does NOT change how assemblies are EXPORTED: interchange files
   * still go through repeated STEPControl_Writer.Transfer / IGESControl_Writer
   * .AddShape, which keeps each body's identity. Fusing into one shape would
   * WELD mated parts into a single solid — a compound is the right in-memory
   * representation, not a substitute for per-body transfer.
   */
  it("binds a constructible gp_Quaternion + compound builder (§2.11.2)", () => {
    // Quaternion → gp_Trsf, the route transformRigid() takes.
    const q = new oc.gp_Quaternion_2(0, 0, Math.SQRT1_2, Math.SQRT1_2);
    const trsf = new oc.gp_Trsf_1();
    trsf.SetRotation_2(q);
    // Rz(90°) maps +X to +Y — proves the quaternion actually reached the matrix.
    const p = new oc.gp_Pnt_3(1, 0, 0);
    p.Transform(trsf);
    expect(p.X()).toBeCloseTo(0, 9);
    expect(p.Y()).toBeCloseTo(1, 9);
    p.delete();
    trsf.delete();
    q.delete();

    // A real compound: build one, add two disjoint boxes, and confirm the
    // assembled shape carries both (volume sums, and it explores as 2 solids).
    const a = makeBox(oc, 0.02, 0.02, 0.02);
    const b = translate(oc, a, [0.1, 0, 0]);
    const builder = new oc.BRep_Builder();
    const compound = new oc.TopoDS_Compound();
    builder.MakeCompound(compound);
    builder.Add(compound, a.shape);
    builder.Add(compound, b.shape);
    const assembled = new Solid(oc, compound);
    try {
      expect(massProperties(oc, assembled, 1).volume).toBeCloseTo(2 * 0.02 ** 3, 12);
      const S = shapeEnums(oc);
      const exp = new oc.TopExp_Explorer_2(assembled.shape, S.TopAbs_SOLID, S.TopAbs_SHAPE);
      let solids = 0;
      while (exp.More()) {
        solids++;
        exp.Next();
      }
      exp.delete();
      expect(solids, "the compound holds both bodies, unwelded").toBe(2);
    } finally {
      assembled.delete(); // owns `compound`
      builder.delete();
      b.delete();
      a.delete();
    }

    // The accumulating writers the export path actually uses stay available.
    const step = new oc.STEPControl_Writer_1();
    expect(typeof step.Transfer).toBe("function");
    step.delete();
    const iges = new oc.IGESControl_Writer_1();
    expect(typeof iges.AddShape).toBe("function");
    iges.delete();
  });

  it("transformRigid poses a solid by quaternion + translation", () => {
    // A 90° rotation about +Z then a lift: the box's centroid must land at the
    // rotated-then-translated point, proving the hand-built matrix is correct.
    const box = makeBox(oc, 0.04, 0.03, 0.02); // corner at origin → centroid (0.02,0.015,0.01)
    const q: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // Rz(90°)
    const posed = transformRigid(oc, box, q, [0, 0, 0.5]);
    try {
      const c = massProperties(oc, posed, 1).com;
      // Rz(90°): (x,y,z) → (−y,x,z), then +0.5 in z.
      expect(c[0]).toBeCloseTo(-0.015, 9);
      expect(c[1]).toBeCloseTo(0.02, 9);
      expect(c[2]).toBeCloseTo(0.01 + 0.5, 9);
    } finally {
      posed.delete();
      box.delete();
    }
  });

  /**
   * §2.5 item 4 — the CORRECTION. `Standard_Failure` is now BOUND (2026-07-18
   * rebuild), and binding it was expected to let describeOcctError() read OCCT's
   * own text via GetMessageString(). Measured: it does NOT. An OCCT throw still
   * unwinds to JS as a raw C++ exception POINTER (a plain number) — it is not an
   * embind-wrapped Standard_Failure, `instanceof oc.Standard_Failure` is false,
   * and the module exposes no `___cxa_begin_catch` to adjust the pointer with.
   * Binding a class makes it constructible; it does not change how a C++ throw
   * crosses into JS.
   *
   * The remaining route is Emscripten's `getExceptionMessage` helper, which needs
   * `-sEXPORT_EXCEPTION_HANDLING_HELPERS` — and occt.build.yml documents that
   * overriding `emccFlags` REPLACES the builder's known-good defaults. So
   * describeOcctError() keeps degrading honestly, and this test pins WHY, so the
   * "just bind Standard_Failure" idea is not tried a third time.
   */
  it("Standard_Failure binds but an OCCT throw still arrives as a raw pointer (§2.5)", () => {
    expect(typeof oc.Standard_Failure).toBe("function"); // bound + constructible now
    let caught: unknown;
    try {
      const d = new oc.gp_Dir_4(0, 0, 0); // null direction → Standard_ConstructionError
      d.delete();
    } catch (e) {
      caught = e;
    }
    expect(typeof caught, "OCCT still throws a raw pointer, not an object").toBe("number");
    expect(caught instanceof (oc.Standard_Failure as never)).toBe(false);
    expect((caught as { GetMessageString?: unknown }).GetMessageString).toBeUndefined();
    // …so the honest generic message is what the user gets.
    expect(describeOcctError(caught)).toMatch(/geometry kernel rejected this operation/);
    expect(isRawOcctFailure(caught)).toBe(true);
  });

  /**
   * §13.2 helix pcurve path is LIVE: gp_Pnt2d / gp_Dir2d are bound, so
   * Geom2d_Line_3 + MakeEdge_31 + BuildCurves3d construct without UnboundTypeError.
   */
  it("binds helix pcurve symbols — gp_Pnt2d / Geom2d_Line construct (§13.2)", () => {
    expect(typeof oc.Geom_CylindricalSurface_1).toBe("function");
    expect(typeof oc.Geom_ConicalSurface_1).toBe("function");
    expect(typeof oc.Geom2d_Line_3).toBe("function");
    expect(typeof oc.gp_Pnt2d_3).toBe("function");
    expect(typeof oc.gp_Dir2d_4).toBe("function");
    expect(typeof oc.Handle_Geom2d_Curve_2).toBe("function");
    expect(typeof oc.Handle_Geom_Surface_2).toBe("function");
    expect(typeof oc.BRepBuilderAPI_MakeEdge_31).toBe("function");
    expect(typeof oc.BRepLib.BuildCurves3d_2).toBe("function");

    // Surfaces actually construct.
    const o = new oc.gp_Pnt_3(0, 0, 0);
    const d = new oc.gp_Dir_4(0, 0, 1);
    const ax = new oc.gp_Ax3_4(o, d);
    const cyl = new oc.Geom_CylindricalSurface_1(ax, 0.01);
    expect(cyl.Radius()).toBeCloseTo(0.01, 12);

    // Exact pcurve path: 2d line on the cylinder over one turn UV span.
    const p0 = new oc.gp_Pnt2d_3(0, 0);
    const d2 = new oc.gp_Dir2d_4(1, 0); // pure-U direction for construct pin
    const line2d = new oc.Geom2d_Line_3(p0, d2);
    const hC = new oc.Handle_Geom2d_Curve_2(line2d);
    const hS = new oc.Handle_Geom_Surface_2(cyl);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_31(hC, hS, 0, Math.PI / 2);
    expect(edgeMaker.IsDone()).toBe(true);
    const edge = edgeMaker.Edge();
    expect(edge.IsNull()).toBe(false);
    expect(oc.BRepLib.BuildCurves3d_2(edge)).toBe(true);

    edge.delete();
    edgeMaker.delete();
    hS.delete();
    hC.delete();
    // line2d owned by handle; p0/d2 still ours
    p0.delete();
    d2.delete();
    cyl.delete();
    ax.delete();
    d.delete();
    o.delete();
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
