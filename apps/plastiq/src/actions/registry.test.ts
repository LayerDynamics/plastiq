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
      "rib",
      "sweep",
      "helixSweep",
      "mirror",
      "linearPattern",
      "circularPattern",
      "pathPattern",
      "split",
      "booleanBody",
      "transform",
      "import-step",
      "import-iges",
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
    // Demo injectors removed from product surface (C4/C5/C7).
    expect(ACTIONS["boolean"]).toBeUndefined();
    expect(ACTIONS["demo-transform"]).toBeUndefined();
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

  it("disables mate mode while the assembly is exploded (R7/S4)", () => {
    expect(ACTIONS["mate-mode"]!.enabled(makeTarget({ explodeFactor: 0 }))).toBe(true);
    expect(ACTIONS["mate-mode"]!.enabled(makeTarget({ explodeFactor: 0.5 }))).toBe(false);
  });

  it("mirror / pattern append features with defaults when nothing is selected (C6)", () => {
    runAction("mirror", makeTarget());
    runAction("linearPattern", makeTarget());
    runAction("circularPattern", makeTarget());
    runAction("pathPattern", makeTarget());
    runAction("split", makeTarget());
    // Without sketches, loft/sweep/helixSweep/booleanBody are disabled or no-op (no demo injectors).
    expect(ACTIONS["loft"]!.enabled(makeTarget())).toBe(false);
    expect(ACTIONS["sweep"]!.enabled(makeTarget())).toBe(false);
    expect(ACTIONS["helixSweep"]!.enabled(makeTarget())).toBe(false);
    expect(ACTIONS["booleanBody"]!.enabled(makeTarget())).toBe(false);
    expect(ACTIONS["demo-transform"]).toBeUndefined();
    expect(ACTIONS["boolean"]).toBeUndefined();
    const feats = useCadStore.getState().features;
    expect(feats.map((f) => f.type)).toEqual([
      "mirror",
      "linearPattern",
      "circularPattern",
      "pathPattern",
      "split",
    ]);
    expect(feats[0]!.params).toEqual({ nx: 1, ny: 0, nz: 0, ox: 0, oy: 0, oz: 0, merge: 1 });
    expect(feats[1]!.params).toMatchObject({ dx: 1, spacing: 0.08, count: 3 });
    expect(feats[2]!.params).toMatchObject({ az: 1, count: 4 });
    expect(feats[3]!.params).toMatchObject({ count: 3 });
    expect(feats[3]!.data).toMatchObject({
      path: { kind: "polyline" },
      align: false,
    });
    expect(feats[4]!.data).toMatchObject({
      plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
    });
    // Status explains how to drive selection (last action's message).
    expect(useCadStore.getState().status).toMatch(/select an edge|face|plane/i);
  });

  it("mirror uses selected face plane origin + normal (C6)", () => {
    const face = {
      normal: [0, 1, 0] as [number, number, number],
      centroid: [0.01, 0.02, 0.03] as [number, number, number],
    };
    runAction(
      "mirror",
      makeTarget({
        kind: "face",
        picks: [{ kind: "face", id: 7 }],
        refs: { faces: { 7: face }, edges: {} },
      }),
    );
    const f = useCadStore.getState().features[0]!;
    expect(f.type).toBe("mirror");
    expect(f.params).toMatchObject({
      nx: 0,
      ny: 1,
      nz: 0,
      ox: 0.01,
      oy: 0.02,
      oz: 0.03,
      merge: 1,
    });
    expect(useCadStore.getState().status).toMatch(/face/i);
  });

  it("linearPattern uses selected edge direction as unit dx/dy/dz (C6)", () => {
    // Edge between +Z and +X faces → tangent ≈ +Y (n0 × n1).
    const edge = {
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ] as [[number, number, number], [number, number, number]],
      midpoint: [0.05, 0, 0.05] as [number, number, number],
    };
    runAction(
      "linearPattern",
      makeTarget({
        kind: "edge",
        picks: [{ kind: "edge", id: 3 }],
        refs: { faces: {}, edges: { 3: edge } },
      }),
    );
    const f = useCadStore.getState().features[0]!;
    expect(f.type).toBe("linearPattern");
    expect(f.params!["dx"]).toBeCloseTo(0, 9);
    expect(f.params!["dy"]).toBeCloseTo(1, 9);
    expect(f.params!["dz"]).toBeCloseTo(0, 9);
    expect(f.params).toMatchObject({ spacing: 0.08, count: 3 });
    expect(useCadStore.getState().status).toMatch(/edge/i);
  });

  it("circularPattern uses edge as axis, or face normal through face point (C6)", () => {
    const edge = {
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ] as [[number, number, number], [number, number, number]],
      midpoint: [0.04, 0.01, 0.02] as [number, number, number],
    };
    runAction(
      "circularPattern",
      makeTarget({
        kind: "edge",
        picks: [{ kind: "edge", id: 2 }],
        refs: { faces: {}, edges: { 2: edge } },
      }),
    );
    let f = useCadStore.getState().features[0]!;
    expect(f.type).toBe("circularPattern");
    expect(f.params!["ax"]).toBeCloseTo(0, 9);
    expect(f.params!["ay"]).toBeCloseTo(1, 9);
    expect(f.params!["az"]).toBeCloseTo(0, 9);
    expect(f.params).toMatchObject({ ox: 0.04, oy: 0.01, oz: 0.02, count: 4 });
    expect(useCadStore.getState().status).toMatch(/edge/i);

    useCadStore.getState().reset();
    const face = {
      normal: [1, 0, 0] as [number, number, number],
      centroid: [0.06, 0, 0] as [number, number, number],
    };
    runAction(
      "circularPattern",
      makeTarget({
        kind: "face",
        picks: [{ kind: "face", id: 9 }],
        refs: { faces: { 9: face }, edges: {} },
      }),
    );
    f = useCadStore.getState().features[0]!;
    expect(f.type).toBe("circularPattern");
    expect(f.params).toMatchObject({
      ax: 1,
      ay: 0,
      az: 0,
      ox: 0.06,
      oy: 0,
      oz: 0,
      count: 4,
    });
    expect(useCadStore.getState().status).toMatch(/face/i);
  });

  it("transform opens the gizmo instead of injecting a feature (T18/C7)", () => {
    runAction("transform", makeTarget());
    expect(useCadStore.getState().gizmoMode).toBe("translate");
    expect(useCadStore.getState().status).toMatch(/gizmo/i);
    expect(useCadStore.getState().features).toHaveLength(0);
  });

  it("hole from face+vertex stores origin vector from VertexRef and originVertex (R12)", () => {
    const face = {
      normal: [0, 0, 1] as [number, number, number],
      centroid: [0.03, 0.02, 0.03] as [number, number, number],
    };
    const vertex = { position: [0.06, 0.04, 0.03] as [number, number, number] };
    runAction(
      "hole",
      makeTarget({
        kind: "face",
        picks: [
          { kind: "face", id: 1 },
          { kind: "vertex", id: 7 },
        ],
        refs: {
          faces: { 1: face },
          edges: {},
          vertices: { 7: vertex },
        },
      }),
    );
    const f = useCadStore.getState().features[0]!;
    expect(f.type).toBe("hole");
    // Origin is still the hole contract's 3-vector — taken from VertexRef.position.
    expect(f.data!["origin"]).toEqual([0.06, 0.04, 0.03]);
    // Persistent signature for rebuild re-resolve (not a bare pick index).
    expect(f.data!["originVertex"]).toEqual(vertex);
    // Axis still drills along the face's inward normal (−normal).
    const axis = f.data!["axis"] as number[];
    expect(axis[0]).toBeCloseTo(0, 12);
    expect(axis[1]).toBeCloseTo(0, 12);
    expect(axis[2]).toBeCloseTo(-1, 12);
    expect(useCadStore.getState().status).toMatch(/vertex/i);
  });

  it("cylinder placement origin comes from a picked VertexRef (R12)", () => {
    const vertex = { position: [0.01, 0.02, 0.03] as [number, number, number] };
    runAction(
      "cylinder",
      makeTarget({
        kind: "vertex",
        picks: [{ kind: "vertex", id: 3 }],
        refs: { faces: {}, edges: {}, vertices: { 3: vertex } },
      }),
    );
    const f = useCadStore.getState().features[0]!;
    expect(f.type).toBe("cylinder");
    expect(f.params).toMatchObject({ ox: 0.01, oy: 0.02, oz: 0.03 });
  });

  it("loft / sweep / rib from finished sketches append real features", () => {
    // Two sketches → loft enabled and runs.
    useCadStore.getState().addFeature({
      type: "sketch",
      data: {
        profile: {
          kind: "loop",
          start: [0, 0],
          segments: [
            { kind: "line", to: [0.04, 0] },
            { kind: "line", to: [0.04, 0.03] },
            { kind: "line", to: [0, 0.03] },
          ],
        },
      },
    });
    useCadStore.getState().addFeature({
      type: "sketch",
      data: {
        profile: {
          kind: "loop",
          start: [0, 0],
          segments: [
            { kind: "line", to: [0.02, 0] },
            { kind: "line", to: [0.02, 0.015] },
            { kind: "line", to: [0, 0.015] },
          ],
        },
        plane: { base: "XY", offset: 0.06 },
      },
    });
    expect(ACTIONS["loft"]!.enabled(makeTarget())).toBe(true);
    runAction("loft", makeTarget());
    expect(useCadStore.getState().features.some((f) => f.type === "loft")).toBe(true);
    expect(useCadStore.getState().status).toMatch(/Loft:.*sketches/i);

    expect(ACTIONS["sweep"]!.enabled(makeTarget())).toBe(true);
    runAction("sweep", makeTarget());
    expect(useCadStore.getState().features.some((f) => f.type === "sweep")).toBe(true);
    expect(useCadStore.getState().status).toMatch(/Sweep: profile from sketch/i);

    expect(ACTIONS["rib"]!.enabled(makeTarget())).toBe(true);
    runAction("rib", makeTarget());
    const rib = useCadStore.getState().features.find((f) => f.type === "rib")!;
    expect(rib.params).toEqual({ length: 0.01 });
    expect(rib.data).toMatchObject({ op: "join", sketchId: expect.any(String) });
    expect(rib.deps).toEqual([rib.data!["sketchId"]]);
  });

  it("loft uses ALL finished sketches as multi-sections, not only last two (C4)", () => {
    const prof = (s: number) => ({
      kind: "loop" as const,
      start: [0, 0] as [number, number],
      segments: [
        { kind: "line" as const, to: [s, 0] as [number, number] },
        { kind: "line" as const, to: [s, s] as [number, number] },
        { kind: "line" as const, to: [0, s] as [number, number] },
      ],
    });
    const a = useCadStore.getState().addFeature({
      type: "sketch",
      data: { profile: prof(0.04) },
    });
    const b = useCadStore.getState().addFeature({
      type: "sketch",
      data: { profile: prof(0.03), plane: { base: "XY", offset: 0.03 } },
    });
    const c = useCadStore.getState().addFeature({
      type: "sketch",
      data: { profile: prof(0.02), plane: { base: "XY", offset: 0.06 } },
    });
    runAction("loft", makeTarget());
    const loft = useCadStore.getState().features.find((f) => f.type === "loft")!;
    const sections = loft.data!["sections"] as unknown[];
    expect(sections).toHaveLength(3);
    expect(useCadStore.getState().status).toMatch(/3 sections/);
    expect(useCadStore.getState().status).toContain(a);
    expect(useCadStore.getState().status).toContain(b);
    expect(useCadStore.getState().status).toContain(c);
  });

  it("booleanBody uses selected sketch as tool, never DEFAULT_RECT (C5)", () => {
    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.04, dy: 0.04, dz: 0.03 } });
    const sk1 = useCadStore.getState().addFeature({
      type: "sketch",
      data: {
        profile: {
          kind: "loop",
          start: [0, 0],
          segments: [
            { kind: "line", to: [0.01, 0] },
            { kind: "line", to: [0.01, 0.01] },
            { kind: "line", to: [0, 0.01] },
          ],
        },
      },
    });
    const sk2 = useCadStore.getState().addFeature({
      type: "sketch",
      data: {
        profile: {
          kind: "circle",
          center: [0.02, 0.02],
          radius: 0.005,
        },
      },
    });
    // Select the first sketch — not the last — as the tool profile.
    useCadStore.getState().selectFeature(sk1);
    expect(ACTIONS["booleanBody"]!.enabled(makeTarget())).toBe(true);
    runAction("booleanBody", makeTarget());
    const bo = useCadStore.getState().features.find((f) => f.type === "boolean")!;
    expect(bo.data!["op"]).toBe("subtract");
    const tools = bo.data!["toolFeatures"] as {
      type: string;
      data?: { profile?: { kind?: string } };
    }[];
    expect(tools[0]!.type).toBe("sketch");
    expect(tools[0]!.data?.profile?.kind).toBe("loop"); // sk1, not sk2's circle
    expect(tools[1]!.type).toBe("extrude");
    expect(useCadStore.getState().status).toContain(sk1);
    expect(useCadStore.getState().status).not.toContain(sk2);
  });

  it("booleanBody uses selected solid primitive as tool body (C5)", () => {
    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.04, dy: 0.04, dz: 0.03 } });
    const cyl = useCadStore.getState().addFeature({
      type: "cylinder",
      params: { radius: 0.005, height: 0.05 },
    });
    useCadStore.getState().selectFeature(cyl);
    runAction("booleanBody", makeTarget());
    const bo = useCadStore.getState().features.find((f) => f.type === "boolean")!;
    const tools = bo.data!["toolFeatures"] as { type: string }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe("cylinder");
    expect(useCadStore.getState().status).toMatch(/cylinder/);
  });

  it("sweep prefers selected sketch as profile (C4)", () => {
    const s1 = useCadStore.getState().addFeature({
      type: "sketch",
      data: {
        profile: { kind: "circle", center: [0, 0], radius: 0.005 },
      },
    });
    useCadStore.getState().addFeature({
      type: "sketch",
      data: {
        profile: { kind: "circle", center: [0, 0], radius: 0.01 },
        plane: { base: "XY", offset: 0.02 },
      },
    });
    useCadStore.getState().selectFeature(s1);
    runAction("sweep", makeTarget());
    const sw = useCadStore.getState().features.find((f) => f.type === "sweep")!;
    expect(sw.data!["profile"]).toMatchObject({ kind: "circle", radius: 0.005 });
    expect(useCadStore.getState().status).toContain(s1);
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
      "helixSweep",
      "mirror",
      "linearPattern",
      "circularPattern",
      "pathPattern",
      "split",
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
    expect(() =>
      runAction("ml-reconstruct-brep", makeTarget({ activeMeshDoc: null })),
    ).not.toThrow();
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
    for (const id of [
      "loft",
      "sweep",
      "mirror",
      "booleanBody",
      "ml-reconstruct-brep",
      "ml-fit-nurbs",
    ]) {
      expect(ACTIONS[id]!.enabled(t), id).toBe(false);
    }
  });

  it("editor-state actions (undo/redo, selection mode) stay available in cloud mode", () => {
    expect(ACTIONS["selmode-edge"]!.enabled(makeTarget())).toBe(true);
    useCadStore.getState().addFeature({ type: "extrude", params: { height: 0.02 } });
    expect(ACTIONS["undo"]!.enabled(makeTarget())).toBe(true);
  });
});
