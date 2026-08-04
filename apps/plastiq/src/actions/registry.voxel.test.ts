// @vitest-environment jsdom
// ADR-0010 wiring — voxel mode in the action registry, a NEW file so it doesn't
// contend with registry.test.ts (the mesh-mode FR-18 coverage):
//   • voxelMode() gates every B-rep/parametric action disabled-not-hidden;
//   • the voxel tool set is enabled/active only with a sculpt open;
//   • undo/redo route to the SCULPT history while sculpting;
//   • Convert-to-CAD stages the surface mesh as the exact activeMeshDoc shape the
//     GenerationPanel's MeshConvertSection consumes (panel unmodified);
//   • Export GLB downloads the surface mesh through the shared exportMeshGlb path.

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { docToGrid } from "../voxel/doc.js";
import { base64ToBytes } from "../mesh/exportGlb.js";
import type { ContextTarget } from "../three/contextmenu/contextSelection.js";
import type { VoxelDoc } from "../store/types.js";
import { ACTIONS, meshMode, runAction, voxelMode } from "./registry.js";

const VOXEL_DOC: VoxelDoc = {
  kind: "voxel",
  name: "Bust",
  dims: [4, 4, 4],
  voxelSize: 0.002,
  origin: [0, 0, 0],
  cells: [21], // one voxel at [1,1,1]
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

afterEach(() => {
  useVoxelStore.getState().close();
  useProjectsStore.setState({
    activeMeshDoc: null,
    currentId: null,
    currentName: "Untitled",
    status: "",
  });
  useCadStore.getState().reset();
  delete (globalThis as { __plastiqViewport?: unknown }).__plastiqViewport;
  delete (globalThis as { __plastiqMeshEdit?: unknown }).__plastiqMeshEdit;
  vi.restoreAllMocks();
});

describe("registry — voxelMode() gates B-rep ops disabled-not-hidden (FR-18)", () => {
  it("voxelMode() reflects the open sculpt", () => {
    expect(voxelMode()).toBe(false);
    useVoxelStore.getState().open(VOXEL_DOC);
    expect(voxelMode()).toBe(true);
    expect(meshMode()).toBe(false); // orthogonal to mesh mode
  });

  it("B-rep feature ops + parametric I/O are disabled (still PRESENT) on a sculpt", () => {
    useVoxelStore.getState().open(VOXEL_DOC);
    const t = makeTarget();
    for (const id of [
      "extrude",
      "cut",
      "revolve",
      "loft",
      "sweep",
      "helixSweep",
      "mirror",
      "linearPattern",
      "circularPattern",
      "pathPattern",
      "split",
      "booleanBody",
      "transform",
      "sketch-rect",
      "import-step",
      "export-gltf",
      "export-step",
      "export-iges",
      "insert-instance",
      "mate-mode",
    ]) {
      expect(ACTIONS[id], id).toBeDefined(); // disabled, never hidden
      expect(ACTIONS[id]!.enabled(t), id).toBe(false);
    }
  });

  it("a disabled B-rep action is a no-op when run on a sculpt", () => {
    useVoxelStore.getState().open(VOXEL_DOC);
    runAction("loft", makeTarget());
    runAction("transform", makeTarget());
    expect(useCadStore.getState().features).toHaveLength(0);
  });

  it("editor-state actions (selection mode) stay available while sculpting", () => {
    useVoxelStore.getState().open(VOXEL_DOC);
    expect(ACTIONS["selmode-edge"]!.enabled(makeTarget())).toBe(true);
  });

  it("the voxel tool set is disabled while a MESH document is open (allowlist symmetry)", () => {
    useProjectsStore.setState({
      activeMeshDoc: {
        kind: "mesh",
        glb: "Z2xURg==",
        source: { mode: "text3d", providerId: "fal:tripo" },
      },
    });
    for (const id of [
      "voxel-new",
      "voxel-add",
      "voxel-erase",
      "voxel-convert-cad",
      "voxel-export-glb",
    ]) {
      expect(ACTIONS[id]!.enabled(makeTarget()), id).toBe(false);
    }
  });
});

describe("registry — the voxel tool set", () => {
  it("bakes the rendered CAD body into an SDF sculpt through the visible bridge", () => {
    const geometry = new THREE.BoxGeometry(0.04, 0.03, 0.02);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);
    (
      globalThis as {
        __plastiqViewport?: { builtPart: { mesh: THREE.Mesh<THREE.BufferGeometry> } };
      }
    ).__plastiqViewport = { builtPart: { mesh } };
    useCadStore.setState({
      features: [{ id: "f1", type: "box", params: { sx: 0.04, sy: 0.03, sz: 0.02 } }],
    });

    expect(ACTIONS["voxel-from-cad"]!.enabled(makeTarget())).toBe(true);
    runAction("voxel-from-cad", makeTarget());

    const doc = useVoxelStore.getState().doc!;
    expect(doc.version).toBe(2);
    expect(doc.sdf?.field.length).toBe(doc.dims[0] * doc.dims[1] * doc.dims[2]);
    expect(doc.cells.length).toBeGreaterThan(0);
    expect(useCadStore.getState().workspace).toBe("sculpt");
    geometry.dispose();
  });

  it("voxel-new starts a fresh untitled sculpt in the Sculpt workspace", () => {
    runAction("voxel-new", makeTarget());
    expect(useVoxelStore.getState().doc).not.toBeNull();
    expect(useProjectsStore.getState().currentId).toBeNull();
    expect(useCadStore.getState().workspace).toBe("sculpt");
  });

  it("voxel-add / voxel-erase select the tool and report active", () => {
    const t = makeTarget();
    expect(ACTIONS["voxel-add"]!.enabled(t)).toBe(false); // no sculpt open yet
    useVoxelStore.getState().open(VOXEL_DOC);
    expect(ACTIONS["voxel-add"]!.enabled(t)).toBe(true);
    expect(ACTIONS["voxel-add"]!.active!(t)).toBe(true); // add is the default tool

    runAction("voxel-erase", t);
    expect(useVoxelStore.getState().tool).toBe("erase");
    expect(ACTIONS["voxel-erase"]!.active!(t)).toBe(true);
    expect(ACTIONS["voxel-add"]!.active!(t)).toBe(false);

    runAction("voxel-add", t);
    expect(useVoxelStore.getState().tool).toBe("add");
  });

  it("undo/redo route to the SCULPT history while a sculpt is open", () => {
    // Seed parametric history so a mis-route would visibly undo the wrong document.
    useCadStore.getState().addFeature({ type: "extrude", params: { height: 0.02 } });
    useVoxelStore.getState().open(VOXEL_DOC);
    const t = makeTarget();

    expect(ACTIONS["undo"]!.enabled(t)).toBe(false); // sculpt history empty
    useVoxelStore.getState().setCell([0, 0, 0], true);
    expect(ACTIONS["undo"]!.enabled(t)).toBe(true);

    runAction("undo", t);
    expect(useVoxelStore.getState().doc).toEqual(VOXEL_DOC); // sculpt edit undone
    expect(useCadStore.getState().features).toHaveLength(1); // parametric doc untouched

    expect(ACTIONS["redo"]!.enabled(t)).toBe(true);
    runAction("redo", t);
    expect(useVoxelStore.getState().doc!.cells).toContain(0);

    // Closing the sculpt returns undo to the parametric history.
    useVoxelStore.getState().close();
    runAction("undo", t);
    expect(useCadStore.getState().features).toHaveLength(0);
  });
});

describe("registry — mesh sculpt product actions", () => {
  it("dispatches inflate, smooth, remesh, and decimate to the live mesh editor", () => {
    const commands = {
      inflateSelection: vi.fn(),
      smoothSelection: vi.fn(),
      remesh: vi.fn(),
      decimate: vi.fn(),
    };
    (globalThis as { __plastiqMeshEdit?: typeof commands }).__plastiqMeshEdit = commands;
    useProjectsStore.setState({
      activeMeshDoc: {
        kind: "mesh",
        glb: "Z2xURg==",
        source: { mode: "voxel", providerId: "voxel-sculpt" },
      },
    });
    useCadStore.setState({ picks: [{ kind: "vertex", id: 0 }] });

    for (const [id, command] of [
      ["mesh-inflate", "inflateSelection"],
      ["mesh-smooth", "smoothSelection"],
      ["mesh-remesh", "remesh"],
      ["mesh-decimate", "decimate"],
    ] as const) {
      expect(ACTIONS[id]!.enabled(makeTarget())).toBe(true);
      runAction(id, makeTarget());
      expect(commands[command]).toHaveBeenCalledOnce();
    }
  });
});

describe("registry — Convert-to-CAD handoff (surface mesh → the mesh reconstruct path)", () => {
  it("stages the sculpt surface as the exact activeMeshDoc shape MeshConvertSection consumes", () => {
    useVoxelStore.getState().open(VOXEL_DOC);
    useProjectsStore.setState({ currentId: "v1", currentName: "Bust" });

    expect(ACTIONS["voxel-convert-cad"]!.enabled(makeTarget())).toBe(true);
    runAction("voxel-convert-cad", makeTarget());

    const st = useProjectsStore.getState();
    const staged = st.activeMeshDoc!;
    expect(staged.kind).toBe("mesh");
    expect(staged.name).toBe("Bust");
    expect(staged.source).toEqual({ mode: "voxel", providerId: "voxel-sculpt" });
    // The GLB payload is a real binary glTF of the sculpt's surface mesh.
    const bytes = base64ToBytes(staged.glb);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x46546c67); // "glTF"
    // Mirrors the panel's own convert flow: a fresh untitled doc; sculpt closed;
    // back in Design where the mesh view + convert panel live.
    expect(st.currentId).toBeNull();
    expect(useVoxelStore.getState().doc).toBeNull();
    expect(voxelMode()).toBe(false);
    expect(meshMode()).toBe(true);
    expect(useCadStore.getState().workspace).toBe("design");
    expect(st.status).toContain("Convert to CAD");
  });

  it("is disabled for an EMPTY sculpt (no surface to hand off)", () => {
    useVoxelStore.getState().open({ ...VOXEL_DOC, cells: [] });
    expect(ACTIONS["voxel-convert-cad"]!.enabled(makeTarget())).toBe(false);
    expect(ACTIONS["voxel-export-glb"]!.enabled(makeTarget())).toBe(false);
    runAction("voxel-convert-cad", makeTarget()); // no-op, never a half-staged doc
    expect(useProjectsStore.getState().activeMeshDoc).toBeNull();
  });
});

describe("registry — voxel-export-glb downloads the surface mesh", () => {
  it("drives the shared GLB download path with the sculpt's surface bytes", () => {
    useVoxelStore.getState().open(VOXEL_DOC);
    // jsdom has no URL.createObjectURL — stub the pair the exporter uses.
    const createObjectURL = vi.fn(() => "blob:voxel");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicks: string[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") {
        (el as HTMLAnchorElement).click = () => clicks.push((el as HTMLAnchorElement).download);
      }
      return el;
    });

    runAction("voxel-export-glb", makeTarget());

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clicks).toEqual(["Bust.glb"]);
    expect(useCadStore.getState().status).toBe("exported Bust.glb");
    // Sanity: the blob really was the sculpt's surface (one voxel → 24 vertices).
    const mesh = docToGrid(VOXEL_DOC).toMesh();
    expect(mesh.vertices.length / 3).toBe(24);
  });
});
