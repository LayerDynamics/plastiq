import { beforeEach, describe, expect, it } from "vitest";
import { useCadStore } from "../store/store.js";
import { CONTEXT_ACTIONS } from "../three/contextmenu/config.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";
import { ACTIONS, runAction } from "./registry.js";

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
    worldPoint: [0, 0, 0],
    ...over,
  };
}

describe("action registry — composition", () => {
  it("includes the context-menu actions AND the ribbon-only ops", () => {
    // context-menu actions surfaced
    for (const id of ["extrude", "cut", "revolve", "fillet", "shell", "sketch-on-face"]) {
      expect(ACTIONS[id]).toBeDefined();
    }
    // ribbon-only ops added
    for (const id of [
      "loft",
      "sweep",
      "mirror",
      "linearPattern",
      "circularPattern",
      "boolean",
      "booleanBody",
      "transform",
      "import-step",
      "export-gltf",
      "export-step",
      "export-iges",
      "undo",
      "redo",
      "selmode-face",
      "selmode-edge",
      "selmode-vertex",
      "selmode-body",
      "insert-instance",
    ]) {
      expect(ACTIONS[id]).toBeDefined();
    }
  });

  it("every def has callable label/enabled/run", () => {
    const t = makeTarget();
    for (const a of Object.values(ACTIONS)) {
      expect(typeof a.label(t)).toBe("string");
      expect(typeof a.enabled(t)).toBe("boolean");
      expect(typeof a.run).toBe("function");
    }
  });

  it("derives context actions WITHOUT drift (shared run reference)", () => {
    const ctx = CONTEXT_ACTIONS.find((a) => a.id === "extrude")!;
    expect(ACTIONS["extrude"]!.run).toBe(ctx.run);
    expect(ACTIONS["extrude"]!.enabled).toBe(ctx.enabled);
  });
});

describe("action registry — run() invokes the real store action", () => {
  beforeEach(() => useCadStore.getState().reset());

  it("loft / sweep / mirror / pattern / boolean / transform append features", () => {
    runAction("loft", makeTarget());
    runAction("sweep", makeTarget());
    runAction("mirror", makeTarget());
    runAction("linearPattern", makeTarget());
    runAction("circularPattern", makeTarget());
    runAction("boolean", makeTarget());
    runAction("booleanBody", makeTarget());
    runAction("transform", makeTarget());
    const types = useCadStore.getState().features.map((f) => f.type);
    expect(types).toEqual([
      "loft",
      "sweep",
      "mirror",
      "linearPattern",
      "circularPattern",
      "boolean",
      "boolean", // booleanBody is also a boolean-type feature
      "transform",
    ]);
  });

  it("selmode-* switches the selection mode and reports active", () => {
    runAction("selmode-edge", makeTarget());
    expect(useCadStore.getState().selMode).toBe("edge");
    expect(ACTIONS["selmode-edge"]!.active!(makeTarget({ selMode: "edge" }))).toBe(true);
    expect(ACTIONS["selmode-face"]!.active!(makeTarget({ selMode: "edge" }))).toBe(false);
  });

  it("insert-instance grows the assembly", () => {
    runAction("insert-instance", makeTarget());
    expect(useCadStore.getState().assembly.instances).toHaveLength(1);
  });

  it("undo/redo are gated by history and actually undo", () => {
    expect(ACTIONS["undo"]!.enabled(makeTarget())).toBe(false); // empty history
    useCadStore.getState().addFeature({ type: "extrude", params: { height: 0.02 } });
    expect(ACTIONS["undo"]!.enabled(makeTarget())).toBe(true);
    runAction("undo", makeTarget());
    expect(useCadStore.getState().features).toHaveLength(0);
    expect(ACTIONS["redo"]!.enabled(makeTarget())).toBe(true);
  });

  it("runAction never runs a disabled action (export with no exporter is a no-op)", () => {
    expect(ACTIONS["export-gltf"]!.enabled(makeTarget())).toBe(false);
    expect(() => runAction("export-gltf", makeTarget())).not.toThrow();
    expect(useCadStore.getState().status).not.toMatch(/export/);
  });
});
