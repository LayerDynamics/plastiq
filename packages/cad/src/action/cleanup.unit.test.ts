// action/* failure-path cleanup — UNIT (fake kernel, NOT real OCCT, NOT e2e).
//
// When a feature op fails it must free every OCCT temporary it owns instead of
// leaking it in the long-lived geometry worker. From the caller's side the op
// behaves identically leaked-vs-not (it throws / returns {ok:false} either way),
// so the only honest way to assert the fix is to spy on `.delete()`: each fake
// maker / handle records its OWN distinct label when freed, and we assert the
// shape handle's label specifically — proving the (formerly leaked) null
// `Shape()` allocation is freed, not merely the maker.
//
// The load-bearing invariant (cf. extrude.ts:69-71 / revolve.ts:37-39): a
// `maker.Shape()` is an OWNED embind handle EVEN WHEN NULL, so it must be
// `.delete()`d before the failure throw/return; and the maker / wires / faces
// must be freed even when Build / MakeThickSolidByJoin throws a Standard_Failure.
// Matching real-OCCT success + throw coverage lives in dressup.test.ts,
// loft.smoke.test.ts, boolean.smoke.test.ts, and edgecases.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";
import type { SpinePath } from "../sketch/spine.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";
import { resolveEdgeRef, resolveFaceRef } from "../mesh/resolve.js";
import { buildSpineWire } from "../sketch/spine.js";
import { chamfer, draft, fillet, shell } from "./dressup.js";
import { loft, sweep } from "./loft.js";
import { extrude } from "./extrude.js";
import { union } from "./boolean.js";

// The resolve / spine helpers reach into real geometry; stub them so each op can
// be driven down its failure path with a fake kernel.
vi.mock("../mesh/resolve.js", () => ({
  resolveEdgeRef: vi.fn(),
  resolveFaceRef: vi.fn(),
}));
vi.mock("../sketch/spine.js", () => ({
  buildSpineWire: vi.fn(),
}));

let deleted: string[];
/** A `.delete()` that records `label` against the current run's ledger. */
const del = (label: string) => () => deleted.push(label);
/** A fake `Shape()` handle that reports null and records its own free as "shape". */
const nullShape = (): { IsNull: () => boolean; delete: () => void } => ({
  IsNull: () => true,
  delete: del("shape"),
});
const fakeSolid = (): Solid => ({ shape: {} }) as unknown as Solid;

function stubEdge(label: string): void {
  vi.mocked(resolveEdgeRef).mockReturnValue(
    { delete: del(label) } as unknown as ReturnType<typeof resolveEdgeRef>,
  );
}
function stubFace(label: string): void {
  vi.mocked(resolveFaceRef).mockReturnValue(
    { delete: del(label) } as unknown as ReturnType<typeof resolveFaceRef>,
  );
}
function stubSpine(label: string): void {
  vi.mocked(buildSpineWire).mockReturnValue(
    { delete: del(label) } as unknown as ReturnType<typeof buildSpineWire>,
  );
}

beforeEach(() => {
  deleted = [];
  vi.clearAllMocks();
});

describe("boolean runBoolean() frees the null Shape() handle on the failure return", () => {
  /** A fake un-built boolean op. §2.2 moved the kernel off the convenience ctor
   * (`BRepAlgoAPI_Fuse_3(a, b, range)`, which BUILDS inside the constructor and
   * so silently ignores any later SetFuzzyValue/SetNonDestructive) onto the
   * default ctor + SetArguments/SetTools/Build. That widened the set of owned
   * handles by the two TopTools_ListOfShape operand lists, which this asserts. */
  const fakeOp = (): Record<string, unknown> => ({
    SetArguments: () => {},
    SetTools: () => {},
    SetFuzzyValue: () => {},
    SetNonDestructive: () => {},
    Build: () => {},
    HasErrors: () => false,
    IsDone: () => true,
    Shape: () => nullShape(),
    delete: del("op"),
  });

  it("union returns {ok:false} and deletes the null shape, op, range, and BOTH operand lists", () => {
    let lists = 0;
    const oc = {
      Message_ProgressRange_1: function () {
        return { delete: del("range") };
      },
      TopTools_ListOfShape_1: function () {
        // Two lists are allocated per boolean (arguments + tools); label them
        // distinctly so a fix that frees only one cannot pass.
        const label = lists++ === 0 ? "argList" : "toolList";
        return { Append_1: () => {}, delete: del(label) };
      },
      BRepAlgoAPI_Fuse_1: function () {
        return fakeOp();
      },
    } as unknown as Occt;

    const r = union(oc, fakeSolid(), fakeSolid());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty shape/);
    // The original fix: the null Shape() handle is freed (it leaked before).
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(
      expect.arrayContaining(["shape", "op", "range", "argList", "toolList"]),
    );
  });

  it("frees the op, range, and both operand lists when Build() throws a Standard_Failure", () => {
    let lists = 0;
    const oc = {
      Message_ProgressRange_1: function () {
        return { delete: del("range") };
      },
      TopTools_ListOfShape_1: function () {
        const label = lists++ === 0 ? "argList" : "toolList";
        return { Append_1: () => {}, delete: del(label) };
      },
      BRepAlgoAPI_Fuse_1: function () {
        return {
          ...fakeOp(),
          Build: () => {
            throw new Error("Standard_Failure: unsupported operands");
          },
        };
      },
    } as unknown as Occt;

    // A raw kernel throw must not bypass cleanup: `union` does not catch, so the
    // throw propagates, but every temporary it owns is still freed on the way out.
    expect(() => union(oc, fakeSolid(), fakeSolid())).toThrow(/Standard_Failure/);
    expect(deleted).toEqual(expect.arrayContaining(["op", "range", "argList", "toolList"]));
  });
});

describe("extrude frees face/vec/prism (and a null Shape()) on the failure path", () => {
  const sketchWithFace = (): Sketch =>
    ({ toFace: () => ({ delete: del("face") }), plane: { normal: [0, 0, 1] } }) as unknown as Sketch;

  it("deletes the null shape plus face/vec/prism when Shape() is null", () => {
    const prism = { Shape: () => nullShape(), delete: del("prism") };
    const oc = {
      gp_Vec_4: function () {
        return { delete: del("v") };
      },
      BRepPrimAPI_MakePrism_1: function () {
        return prism;
      },
    } as unknown as Occt;

    expect(() => extrude(oc, sketchWithFace(), 0.02)).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["face", "v", "prism", "shape"]));
  });

  it("frees face/vec/prism when MakePrism throws a Standard_Failure", () => {
    const oc = {
      gp_Vec_4: function () {
        return { delete: del("v") };
      },
      BRepPrimAPI_MakePrism_1: function () {
        throw new Error("Standard_Failure: cannot prism this face");
      },
    } as unknown as Occt;

    expect(() => extrude(oc, sketchWithFace(), 0.02)).toThrow(/Standard_Failure/);
    // No shape was allocated; face and vec are still freed (prism never existed).
    expect(deleted).toEqual(expect.arrayContaining(["face", "v"]));
  });

  it("rejects a zero total height before allocating a face", () => {
    const sketch = {
      toFace: () => {
        throw new Error("toFace must not be called before validation");
      },
      plane: { normal: [0, 0, 1] },
    } as unknown as Sketch;
    expect(() => extrude({} as unknown as Occt, sketch, 0)).toThrow(/height/);
    expect(deleted).toEqual([]);
  });
});

describe("loft frees the maker, progress range, and wires on the failure path", () => {
  const fakeSketches = (): Sketch[] =>
    [
      { toWire: () => ({ delete: del("wire0") }) },
      { toWire: () => ({ delete: del("wire1") }) },
    ] as unknown as Sketch[];

  it("deletes the null shape (plus maker/progress/wires) when Shape() is null", () => {
    // IsDone() is true here: this exercises the "done maker but Shape() came back
    // null" cleanup path (K8 added an IsDone() guard BEFORE Shape()).
    const maker = {
      AddWire: () => {},
      Build: () => {},
      IsDone: () => true,
      Shape: () => nullShape(),
      delete: del("maker"),
    };
    const oc = {
      BRepOffsetAPI_ThruSections: function () {
        return maker;
      },
      Message_ProgressRange_1: function () {
        return { delete: del("progress") };
      },
    } as unknown as Occt;

    expect(() => loft(oc, fakeSketches(), { ruled: true })).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["maker", "progress", "wire0", "wire1"]));
  });

  it("throws the K8 not-done error (and still frees maker/progress/wires) when IsDone() is false", () => {
    // K8: a ThruSections that did not build must be rejected on IsDone() BEFORE
    // Shape() is trusted. Shape() must never be called here — if it were, the
    // guard would be a no-op — so the fake omits it entirely; cleanup still runs.
    const maker = {
      AddWire: () => {},
      Build: () => {},
      IsDone: () => false,
      delete: del("maker"),
    };
    const oc = {
      BRepOffsetAPI_ThruSections: function () {
        return maker;
      },
      Message_ProgressRange_1: function () {
        return { delete: del("progress") };
      },
    } as unknown as Occt;

    expect(() => loft(oc, fakeSketches(), { ruled: true })).toThrow(
      /could not build a solid through the given sections/,
    );
    expect(deleted).toEqual(expect.arrayContaining(["maker", "progress", "wire0", "wire1"]));
  });

  it("frees the maker/progress/wires when Build() throws a Standard_Failure", () => {
    const maker = {
      AddWire: () => {},
      Build: () => {
        throw new Error("Standard_Failure: degenerate sections");
      },
      Shape: () => nullShape(),
      delete: del("maker"),
    };
    const oc = {
      BRepOffsetAPI_ThruSections: function () {
        return maker;
      },
      Message_ProgressRange_1: function () {
        return { delete: del("progress") };
      },
    } as unknown as Occt;

    expect(() => loft(oc, fakeSketches(), { ruled: true })).toThrow(/Standard_Failure/);
    // No shape was ever allocated; the maker, progress range, and both wires are freed.
    expect(deleted).toEqual(expect.arrayContaining(["maker", "progress", "wire0", "wire1"]));
  });
});

describe("sweep frees the null Shape() handle before cleanup", () => {
  it("deletes the null shape plus maker/progress/profile/spine", () => {
    stubSpine("spine");
    const maker = {
      SetMode_1: () => {},
      SetTransitionMode: () => {},
      Add_1: () => {},
      IsReady: () => true,
      Build: () => {},
      IsDone: () => true,
      MakeSolid: () => true,
      Shape: () => nullShape(),
      delete: del("maker"),
    };
    const oc = {
      BRepOffsetAPI_MakePipeShell: function () {
        return maker;
      },
      Message_ProgressRange_1: function () {
        return { delete: del("progress") };
      },
      BRepBuilderAPI_TransitionMode: {
        BRepBuilderAPI_RightCorner: 0,
        BRepBuilderAPI_RoundCorner: 1,
        BRepBuilderAPI_Transformed: 2,
      },
    } as unknown as Occt;
    const sketch = { toWire: () => ({ delete: del("profile") }) } as unknown as Sketch;
    const path = { kind: "polyline", points: [[0, 0, 0], [1, 0, 0]] } as unknown as SpinePath;

    expect(() => sweep(oc, sketch, path)).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["maker", "progress", "profile", "spine"]));
  });

  it("frees the maker/progress/profile/spine when Build() throws a Standard_Failure", () => {
    stubSpine("spine");
    const maker = {
      SetMode_1: () => {},
      SetTransitionMode: () => {},
      Add_1: () => {},
      IsReady: () => true,
      Build: () => {
        throw new Error("Standard_Failure: cannot sweep this profile");
      },
      IsDone: () => true,
      MakeSolid: () => true,
      Shape: () => nullShape(),
      delete: del("maker"),
    };
    const oc = {
      BRepOffsetAPI_MakePipeShell: function () {
        return maker;
      },
      Message_ProgressRange_1: function () {
        return { delete: del("progress") };
      },
      BRepBuilderAPI_TransitionMode: {
        BRepBuilderAPI_RightCorner: 0,
        BRepBuilderAPI_RoundCorner: 1,
        BRepBuilderAPI_Transformed: 2,
      },
    } as unknown as Occt;
    const sketch = { toWire: () => ({ delete: del("profile") }) } as unknown as Sketch;
    const path = { kind: "polyline", points: [[0, 0, 0], [1, 0, 0]] } as unknown as SpinePath;

    expect(() => sweep(oc, sketch, path)).toThrow(/Standard_Failure/);
    // A thrown Build must not bypass cleanup — every temporary is still freed.
    expect(deleted).toEqual(expect.arrayContaining(["maker", "progress", "profile", "spine"]));
  });
});

describe("fillet frees the maker (and resolved edges) on the failure path", () => {
  const fakeEdges = (): EdgeRef[] => [{ faceNormals: [] }] as unknown as EdgeRef[];
  const makeOc = (maker: object): Occt =>
    ({
      ChFi3d_FilletShape: { ChFi3d_Rational: 0 },
      BRepFilletAPI_MakeFillet: function () {
        return maker;
      },
    }) as unknown as Occt;

  it("deletes the null shape and the maker when Shape() is null", () => {
    stubEdge("edge");
    const maker = { Add_2: () => {}, Shape: () => nullShape(), delete: del("maker") };

    expect(() => fillet(makeOc(maker), fakeSolid(), fakeEdges(), 0.003)).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["maker", "edge"]));
  });

  it("frees the maker and the in-flight edge when Add_2 throws a Standard_Failure", () => {
    stubEdge("edge");
    const maker = {
      Add_2: () => {
        throw new Error("Standard_Failure: bad edge");
      },
      Shape: () => nullShape(),
      delete: del("maker"),
    };

    expect(() => fillet(makeOc(maker), fakeSolid(), fakeEdges(), 0.003)).toThrow(/Standard_Failure/);
    expect(deleted).toEqual(expect.arrayContaining(["maker", "edge"]));
  });
});

describe("chamfer frees the maker and the null shape on the failure path", () => {
  it("deletes the null shape and the maker when Shape() is null", () => {
    stubEdge("edge");
    const maker = { Add_2: () => {}, Shape: () => nullShape(), delete: del("maker") };
    const oc = {
      BRepFilletAPI_MakeChamfer: function () {
        return maker;
      },
    } as unknown as Occt;

    expect(() =>
      chamfer(oc, fakeSolid(), [{ faceNormals: [] }] as unknown as EdgeRef[], 0.003),
    ).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["maker", "edge"]));
  });
});

describe("shell frees the face list, resolved faces, maker, and progress on failure", () => {
  const fakeFaces = (): FaceRef[] => [{ normal: [0, 0, 1] }] as unknown as FaceRef[];
  const makeOc = (maker: object): Occt =>
    ({
      TopTools_ListOfShape_1: function () {
        return { Append_1: () => {}, delete: del("list") };
      },
      BRepOffsetAPI_MakeThickSolid: function () {
        return maker;
      },
      Message_ProgressRange_1: function () {
        return { delete: del("progress") };
      },
      BRepOffset_Mode: { BRepOffset_Skin: 0 },
      GeomAbs_JoinType: { GeomAbs_Arc: 0 },
    }) as unknown as Occt;

  it("deletes the null shape plus list/faces/maker/progress when Shape() is null", () => {
    stubFace("face");
    const maker = { MakeThickSolidByJoin: () => {}, Shape: () => nullShape(), delete: del("maker") };

    expect(() => shell(makeOc(maker), fakeSolid(), fakeFaces(), 0.003)).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["maker", "progress", "face", "list"]));
  });

  it("frees list/faces/maker/progress when MakeThickSolidByJoin throws (thickness > wall)", () => {
    stubFace("face");
    const maker = {
      MakeThickSolidByJoin: () => {
        throw new Error("Standard_Failure: cannot offset");
      },
      Shape: () => nullShape(),
      delete: del("maker"),
    };

    expect(() => shell(makeOc(maker), fakeSolid(), fakeFaces(), 0.05)).toThrow(/Standard_Failure/);
    expect(deleted).toEqual(expect.arrayContaining(["maker", "progress", "face", "list"]));
  });
});

describe("draft frees the null Shape() handle (and the da/gp temporaries) on failure", () => {
  it("deletes the null shape plus the draft maker and its gp_* temporaries", () => {
    stubFace("face");
    const da = {
      Add: () => {},
      Build: () => {},
      IsDone: () => true,
      Shape: () => nullShape(),
      delete: del("da"),
    };
    const oc = {
      BRepOffsetAPI_DraftAngle_2: function () {
        return da;
      },
      gp_Dir_4: function () {
        return { delete: del("dir") };
      },
      gp_Pnt_3: function () {
        return { delete: del("origin") };
      },
      gp_Pln_3: function () {
        return { delete: del("plane") };
      },
      Message_ProgressRange_1: function () {
        return { delete: del("progress") };
      },
    } as unknown as Occt;

    expect(() =>
      draft(oc, fakeSolid(), {
        face: { normal: [1, 0, 0] },
        pullDirection: [0, 0, 1],
        neutralOrigin: [0, 0, 0],
        neutralNormal: [0, 0, 1],
        angle: 0.1,
      }),
    ).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["da", "plane", "origin", "face", "progress"]));
  });
});
