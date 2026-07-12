import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { MeshDoc, PointCloudDoc } from "../store/types.js";
import { CONTEXT_ACTIONS } from "../three/contextmenu/config.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";
import { ACTIONS, meshMode, pointCloudMode, runAction } from "./registry.js";

const MESH_DOC: MeshDoc = {
  kind: "mesh",
  name: "Generated",
  glb: "Z2xURg==",
  source: { mode: "text3d", providerId: "fal:tripo" },
};

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
      "import-assy",
      "export-assy",
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

  it("derives context actions WITHOUT drift (shared run; enabled delegates to the source)", () => {
    const ctx = CONTEXT_ACTIONS.find((a) => a.id === "extrude")!;
    // `run` is the SAME reference (no copy-paste drift).
    expect(ACTIONS["extrude"]!.run).toBe(ctx.run);
    // `enabled` is now wrapped by the mesh-mode gate (FR-18) but DELEGATES to the source
    // predicate when no mesh document is open — so there is still no logic drift.
    const t = makeTarget();
    expect(ACTIONS["extrude"]!.enabled(t)).toBe(ctx.enabled(t));
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

  it("loft / sweep set status guidance for real authoring (G10)", () => {
    runAction("loft", makeTarget());
    expect(useCadStore.getState().status).toMatch(/Loft:.*sections|demo frustum/i);
    runAction("sweep", makeTarget());
    expect(useCadStore.getState().status).toMatch(/Sweep:.*profile\/path|demo pipe/i);
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

describe("action registry — mesh mode disables B-rep ops (FR-18)", () => {
  beforeEach(() => {
    useCadStore.getState().reset();
    useProjectsStore.setState({ activeMeshDoc: MESH_DOC });
  });
  afterEach(() => useProjectsStore.setState({ activeMeshDoc: null }));

  it("meshMode() reflects the open mesh document", () => {
    expect(meshMode()).toBe(true);
    useProjectsStore.setState({ activeMeshDoc: null });
    expect(meshMode()).toBe(false);
  });

  it("B-rep feature ops + parametric export/import are disabled on a mesh document", () => {
    const t = makeTarget();
    for (const id of [
      "loft",
      "sweep",
      "mirror",
      "linearPattern",
      "circularPattern",
      "transform",
      "import-step",
      "export-gltf",
      "export-step",
      "export-iges",
      "insert-instance",
      "import-assy",
    ]) {
      expect(ACTIONS[id]!.enabled(t)).toBe(false);
    }
  });

  it("a disabled B-rep action is a no-op when run on a mesh document", () => {
    runAction("loft", makeTarget());
    runAction("transform", makeTarget());
    expect(useCadStore.getState().features).toHaveLength(0);
  });

  it("editor-state actions (undo/redo, selection mode) stay available in mesh mode", () => {
    // selection mode is always allowed
    expect(ACTIONS["selmode-edge"]!.enabled(makeTarget())).toBe(true);
    // undo still follows the history predicate (not mesh-gated), here with one feature
    useCadStore.getState().addFeature({ type: "extrude", params: { height: 0.02 } });
    expect(ACTIONS["undo"]!.enabled(makeTarget())).toBe(true);
  });

  it("mesh→CAD conversions (reconstruct / fit-NURBS) are ENABLED on a mesh document", () => {
    // gateForDocMode must NOT force-disable these in mesh mode (they consume the mesh);
    // their own `enabled` gates on the resolved target carrying the open MeshDoc.
    const onMesh = makeTarget({ activeMeshDoc: MESH_DOC });
    expect(ACTIONS["ml-reconstruct-brep"]!.enabled(onMesh)).toBe(true);
    expect(ACTIONS["ml-fit-nurbs"]!.enabled(onMesh)).toBe(true);
  });
});

describe("action registry — mesh→CAD conversions are the inverse gate of B-rep ops", () => {
  beforeEach(() => {
    useCadStore.getState().reset();
    useProjectsStore.setState({ activeMeshDoc: null });
  });

  it("reconstruct / fit-NURBS are DISABLED with no mesh open (nothing to convert)", () => {
    const noMesh = makeTarget({ activeMeshDoc: null });
    expect(ACTIONS["ml-reconstruct-brep"]!.enabled(noMesh)).toBe(false);
    expect(ACTIONS["ml-fit-nurbs"]!.enabled(noMesh)).toBe(false);
  });

  it("running a disabled conversion with no mesh open is a no-op", () => {
    expect(() => runAction("ml-reconstruct-brep", makeTarget({ activeMeshDoc: null }))).not.toThrow();
    expect(useCadStore.getState().features).toHaveLength(0);
  });

  it("both conversions are registered actions (re-exposed from the context catalog)", () => {
    expect(ACTIONS["ml-reconstruct-brep"]).toBeDefined();
    expect(ACTIONS["ml-fit-nurbs"]).toBeDefined();
  });
});

describe("action registry — point-cloud mode disables B-rep ops (SPEC-13, FR-18)", () => {
  const CLOUD_DOC: PointCloudDoc = {
    kind: "pointcloud",
    name: "Scan",
    points: [0, 0, 0, 1, 0, 0],
    source: { mode: "photos3d", providerId: "photogrammetry" },
  };
  beforeEach(() => {
    useCadStore.getState().reset();
    useProjectsStore.setState({ activeMeshDoc: null, activePointCloudDoc: CLOUD_DOC });
  });
  afterEach(() => useProjectsStore.setState({ activePointCloudDoc: null }));

  it("pointCloudMode() reflects the open cloud document", () => {
    expect(pointCloudMode()).toBe(true);
    useProjectsStore.setState({ activePointCloudDoc: null });
    expect(pointCloudMode()).toBe(false);
  });

  it("B-rep feature ops + the mesh→CAD conversions are disabled on a cloud document", () => {
    const t = makeTarget();
    for (const id of ["loft", "sweep", "mirror", "boolean", "ml-reconstruct-brep", "ml-fit-nurbs"]) {
      expect(ACTIONS[id]!.enabled(t), id).toBe(false);
    }
  });

  it("editor-state actions (undo/redo, selection mode) stay available in cloud mode", () => {
    expect(ACTIONS["selmode-edge"]!.enabled(makeTarget())).toBe(true);
    useCadStore.getState().addFeature({ type: "extrude", params: { height: 0.02 } });
    expect(ACTIONS["undo"]!.enabled(makeTarget())).toBe(true);
  });
});
