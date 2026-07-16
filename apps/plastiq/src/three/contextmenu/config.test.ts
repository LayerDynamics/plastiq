import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initSketchSolver, type FaceRef, type EdgeRef } from "@plastiq/cad";
import { useCadStore } from "../../store/store.js";
import { useSketchStore } from "../../sketch/sketchStore.js";

// The sketch constraint action solves via planegcs (async wasm) — load it once so
// the select-then-constrain test re-solves like the live sketcher.
beforeAll(async () => {
  await initSketchSolver();
  useSketchStore.getState().setSolverReady(true);
});
import { CONTEXT_ACTIONS } from "./config.js";
import type { ContextAction } from "./config.js";
import type { ContextTarget } from "./contextSelection.js";

function makeTarget(over: Partial<ContextTarget> = {}): ContextTarget {
  return {
    kind: "empty",
    picks: [],
    selMode: "face",
    refs: { faces: {}, edges: {} },
    features: [],
    selectedFeatureId: null,
    inSketch: false,
    sketchSelection: [],
    sketchModel: null,
    mateMode: false,
    matePickCount: 0,
    simulating: false,
    simPaused: false,
    hasProfile: false,
    solverReady: true,
    section: null,
    measuring: false,
    explodeFactor: 0,
    gizmoMode: "translate",
    instanceId: null,
    activeMeshDoc: null,
    activePointCloudDoc: null,
    worldPoint: [0, 0, 0],
    ...over,
  };
}

const byId = (id: string): ContextAction => {
  const a = CONTEXT_ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`no action ${id}`);
  return a;
};

const faceRef: FaceRef = { normal: [0, 0, 1] } as FaceRef;
const edgeRef: EdgeRef = {
  faceNormals: [
    [0, 0, 1],
    [1, 0, 0],
  ],
} as EdgeRef;

describe("config — catalog integrity", () => {
  it("action ids are unique", () => {
    const ids = CONTEXT_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every action has callable predicates + run", () => {
    for (const a of CONTEXT_ACTIONS) {
      const t = makeTarget();
      expect(typeof a.label(t)).toBe("string");
      expect(typeof a.visible(t)).toBe("boolean");
      expect(typeof a.enabled(t)).toBe("boolean");
      expect(typeof a.run).toBe("function");
    }
  });
});

describe("config — run() invokes the real store/dressup action", () => {
  beforeEach(() => useCadStore.getState().reset());

  it("extrude / cut / revolve append the matching feature", () => {
    byId("extrude").run(makeTarget({ hasProfile: true }));
    byId("cut").run(makeTarget({ hasProfile: true }));
    byId("revolve").run(makeTarget({ hasProfile: true }));
    const types = useCadStore.getState().features.map((f) => f.type);
    expect(types).toEqual(["extrude", "cut", "revolve"]);
  });

  it("fillet builds from the picked edge + ref (FR-30)", () => {
    byId("fillet").run(
      makeTarget({ kind: "edge", picks: [{ kind: "edge", id: 5 }], refs: { faces: {}, edges: { 5: edgeRef } } }),
    );
    const f = useCadStore.getState().features.at(-1);
    expect(f?.type).toBe("fillet");
    expect((f?.data?.["edges"] as unknown[]).length).toBe(1);
  });

  it("shell builds from the picked face + ref", () => {
    byId("shell").run(
      makeTarget({ kind: "face", picks: [{ kind: "face", id: 1 }], refs: { faces: { 1: faceRef }, edges: {} } }),
    );
    expect(useCadStore.getState().features.at(-1)?.type).toBe("shell");
  });

  it("a dress-up with an unresolved selection surfaces a status, adds nothing", () => {
    byId("fillet").run(makeTarget({ kind: "edge", picks: [{ kind: "edge", id: 99 }] }));
    expect(useCadStore.getState().features).toHaveLength(0);
    expect(useCadStore.getState().status).toMatch(/select the edges\/faces/);
  });

  it("section toggles on then off (driven by ctx.section)", () => {
    byId("section").run(makeTarget({ section: null }));
    expect(useCadStore.getState().section).toEqual({
      kind: "axis",
      axis: "x",
      t: 0.5,
      flip: false,
    });
    byId("section").run(
      makeTarget({ section: { kind: "axis", axis: "x", t: 0.5, flip: false } }),
    );
    expect(useCadStore.getState().section).toBeNull();
  });

  it("measure toggles the tool", () => {
    byId("measure").run(makeTarget());
    expect(useCadStore.getState().measuring).toBe(true);
  });

  it("clear-selection empties the picks", () => {
    useCadStore.getState().setPicks([{ kind: "face", id: 1 }]);
    byId("clear-selection").run(makeTarget({ picks: [{ kind: "face", id: 1 }] }));
    expect(useCadStore.getState().picks).toHaveLength(0);
  });

  it("gizmo-rotate sets the transform mode", () => {
    byId("gizmo-rotate").run(makeTarget({ kind: "body" }));
    expect(useCadStore.getState().gizmoMode).toBe("rotate");
  });

  it("explode toggles the exploded-view factor", () => {
    byId("explode").run(makeTarget({ kind: "assemblyInstance", explodeFactor: 0 }));
    expect(useCadStore.getState().explodeFactor).toBeGreaterThan(0);
    byId("explode").run(makeTarget({ kind: "assemblyInstance", explodeFactor: 0.5 }));
    expect(useCadStore.getState().explodeFactor).toBe(0);
  });

  it("suppress + delete act on the selected feature", () => {
    const id = useCadStore.getState().addFeature({ type: "extrude", params: { height: 0.02 } });
    const features = useCadStore.getState().features;
    byId("suppress").run(makeTarget({ kind: "feature", selectedFeatureId: id, features }));
    expect(useCadStore.getState().features.find((f) => f.id === id)?.suppressed).toBe(true);
    byId("delete-feature").run(
      makeTarget({ kind: "feature", selectedFeatureId: id, features: useCadStore.getState().features }),
    );
    expect(useCadStore.getState().features.find((f) => f.id === id)).toBeUndefined();
  });

  it("sim controls drive playback state", () => {
    useCadStore.getState().setSimulating(true);
    byId("sim-pause").run(makeTarget({ simulating: true, simPaused: false }));
    expect(useCadStore.getState().simPaused).toBe(true);
    const before = useCadStore.getState().simStepReq;
    byId("sim-step").run(makeTarget({ simulating: true, simPaused: true }));
    expect(useCadStore.getState().simStepReq).toBe(before + 1);
  });

  it("sk-finish COMMITS the active sketch (persists a profile, not discard)", () => {
    const sk = useSketchStore.getState();
    sk.setSolverReady(true);
    sk.enterSketch("XY");
    // Draw a closed triangle so a profile can be extracted.
    const a = useSketchStore.getState().addPoint({ u: 0, v: 0 });
    const b = useSketchStore.getState().addPoint({ u: 0.03, v: 0 });
    const c = useSketchStore.getState().addPoint({ u: 0.015, v: 0.02 });
    useSketchStore.getState().addEntity({ id: "L1", kind: "line", a, b });
    useSketchStore.getState().addEntity({ id: "L2", kind: "line", a: b, b: c });
    useSketchStore.getState().addEntity({ id: "L3", kind: "line", a: c, b: a });
    const before = useCadStore.getState().features.length;
    byId("sk-finish").run(makeTarget({ inSketch: true }));
    expect(useSketchStore.getState().active).toBe(false);
    expect(useCadStore.getState().features.length).toBe(before + 1);
    const committed = useCadStore.getState().features.at(-1);
    expect(committed?.type).toBe("sketch");
    expect(committed?.data?.["profile"]).toBeDefined();
  });

  it("sk-cancel discards the active sketch (commits nothing)", () => {
    const sk = useSketchStore.getState();
    sk.setSolverReady(true);
    sk.enterSketch("XY");
    const before = useCadStore.getState().features.length;
    byId("sk-cancel").run(makeTarget({ inSketch: true }));
    expect(useSketchStore.getState().active).toBe(false);
    expect(useCadStore.getState().features.length).toBe(before);
  });

  it("a sketch constraint applies to the live model (select-then-constrain)", () => {
    const sk = useSketchStore.getState();
    sk.setSolverReady(true);
    sk.enterSketch("XY");
    const a = useSketchStore.getState().addPoint({ u: 0, v: 0 });
    const b = useSketchStore.getState().addPoint({ u: 1, v: 0.1 });
    useSketchStore.getState().addEntity({ id: "L1", kind: "line", a, b });
    useSketchStore.getState().setSelection(["L1"]);
    const before = useSketchStore.getState().model.constraints.length;
    byId("sk-constraint-horizontal").run(makeTarget({ inSketch: true, sketchSelection: ["L1"] }));
    expect(useSketchStore.getState().model.constraints.length).toBe(before + 1);
    useSketchStore.getState().exitSketch();
  });
});

describe("config — mate prompt Cancel aborts (F6)", () => {
  const realPrompt = globalThis.prompt;
  afterEach(() => {
    globalThis.prompt = realPrompt;
    vi.restoreAllMocks();
  });

  const cases = [
    { id: "mate-distance", kind: "distance" as const, entry: "25", value: 0.025 },
    { id: "mate-angle", kind: "angle" as const, entry: "90", value: (90 * Math.PI) / 180 },
  ];

  for (const { id, kind, entry, value } of cases) {
    it(`${id}: Cancel (prompt → null) applies NO mate`, () => {
      const spy = vi.spyOn(useCadStore.getState(), "applyMate").mockImplementation(() => {});
      globalThis.prompt = () => null;
      byId(id).run(makeTarget({ mateMode: true, matePickCount: 2 }));
      expect(spy).not.toHaveBeenCalled();
    });

    it(`${id}: a blank entry applies NO mate`, () => {
      const spy = vi.spyOn(useCadStore.getState(), "applyMate").mockImplementation(() => {});
      globalThis.prompt = () => "";
      byId(id).run(makeTarget({ mateMode: true, matePickCount: 2 }));
      expect(spy).not.toHaveBeenCalled();
    });

    it(`${id}: a real value DOES apply the mate`, () => {
      const spy = vi.spyOn(useCadStore.getState(), "applyMate").mockImplementation(() => {});
      globalThis.prompt = () => entry;
      byId(id).run(makeTarget({ mateMode: true, matePickCount: 2 }));
      expect(spy).toHaveBeenCalledWith(kind, value);
    });
  }
});
