// ADR-0010 wiring — projectsStore routes `kind:"voxel"` documents end-to-end:
// open() → voxelStore + the Sculpt workspace; New Sculpt / New Project flip the
// mode symmetrically; save()/saveAs() persist the LIVE voxel document (not the
// parametric editor's); recover() unwraps a voxel recovery envelope. The autosave +
// crash-recovery timer path lives in projectsStore.voxelAutosave.test.ts (it needs
// init() + fake timers; this file never wires autosave).

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectsStore, voxelOfRecoveryDoc } from "./projectsStore.js";
import { useCadStore } from "../store/store.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { defaultVoxelDoc } from "../voxel/doc.js";
import { clearRecovery, readRecovery, writeRecovery } from "./recovery.js";
import type { CadDocument, VoxelDoc } from "../store/types.js";
import type { ProjectMeta, ProjectStore } from "./types.js";

const voxelDoc = (): VoxelDoc => ({
  kind: "voxel",
  name: "Sculpted bust",
  dims: [8, 8, 8],
  voxelSize: 0.002,
  origin: [0, 0, 0],
  cells: [0, 1, 9, 73],
});

function meta(id: string, name = "P"): ProjectMeta {
  return { id, name, units: "mm", created: 1, updated: 1, thumbnail: null };
}

/** A ProjectStore whose methods can be overridden per test (defaults all succeed). */
function fakeStore(overrides: Partial<ProjectStore> = {}): ProjectStore {
  return {
    list: async () => [],
    load: async () => null,
    create: async (name) => meta("p1", name),
    save: async () => {},
    rename: async () => {},
    delete: async () => {},
    ...overrides,
  };
}

afterEach(() => {
  useProjectsStore.setState({
    store: null,
    currentId: null,
    currentName: "Untitled",
    status: "",
    activeMeshDoc: null,
    recoverable: null,
    busy: false,
  });
  useVoxelStore.getState().close();
  useCadStore.getState().reset();
  clearRecovery();
  vi.restoreAllMocks();
});

describe("projectsStore — open() routes voxel documents (ADR-0010)", () => {
  it("opening a VOXEL project loads the voxel store + Sculpt workspace, not the parametric editor", async () => {
    const loadSpy = vi.spyOn(useCadStore.getState(), "loadDocument").mockImplementation(() => {});
    useProjectsStore.setState({
      store: fakeStore({ load: async () => ({ meta: meta("v1", "Bust"), doc: voxelDoc() }) }),
    });

    await useProjectsStore.getState().open("v1");

    const st = useProjectsStore.getState();
    expect(useVoxelStore.getState().doc).toEqual(voxelDoc());
    expect(st.activeMeshDoc).toBeNull();
    expect(st.currentId).toBe("v1");
    expect(st.currentName).toBe("Bust");
    expect(st.status).toBe("opened");
    expect(st.busy).toBe(false);
    expect(useCadStore.getState().workspace).toBe("sculpt"); // auto-enters the mode
    expect(loadSpy).not.toHaveBeenCalled(); // voxel docs bypass the B-rep editor
    loadSpy.mockRestore();
  });

  it("opening a PARAMETRIC project closes an open sculpt and leaves the Sculpt workspace", async () => {
    const paramDoc: CadDocument = { features: [], params: {} };
    const loadSpy = vi.spyOn(useCadStore.getState(), "loadDocument").mockImplementation(() => {});
    useVoxelStore.getState().open(voxelDoc());
    useCadStore.getState().setWorkspace("sculpt");
    useProjectsStore.setState({
      store: fakeStore({ load: async () => ({ meta: meta("p9", "Bracket"), doc: paramDoc }) }),
    });

    await useProjectsStore.getState().open("p9");

    expect(loadSpy).toHaveBeenCalledWith(paramDoc);
    expect(useVoxelStore.getState().doc).toBeNull();
    expect(useCadStore.getState().workspace).toBe("design");
    loadSpy.mockRestore();
  });
});

describe("projectsStore — New Sculpt / New Project mode symmetry", () => {
  it("newVoxelProject() opens the default grid untitled, in the Sculpt workspace", () => {
    useProjectsStore.getState().newVoxelProject();

    const st = useProjectsStore.getState();
    expect(useVoxelStore.getState().doc).toEqual(defaultVoxelDoc());
    expect(st.currentId).toBeNull();
    expect(st.currentName).toBe("Untitled");
    expect(st.status).toBe("new voxel sculpt");
    expect(st.activeMeshDoc).toBeNull();
    expect(st.busy).toBe(false);
    expect(useCadStore.getState().workspace).toBe("sculpt");
  });

  it("newProject() from a sculpt closes it and returns to Design", () => {
    const loadSpy = vi.spyOn(useCadStore.getState(), "loadDocument").mockImplementation(() => {});
    useProjectsStore.getState().newVoxelProject();

    useProjectsStore.getState().newProject();

    expect(useVoxelStore.getState().doc).toBeNull();
    expect(useCadStore.getState().workspace).toBe("design");
    expect(useProjectsStore.getState().currentId).toBeNull();
    loadSpy.mockRestore();
  });
});

describe("projectsStore — save/saveAs persist the LIVE voxel document", () => {
  it("save() writes the voxel doc (not the parametric editor doc) and a clean voxel recovery snapshot", async () => {
    const save = vi.fn(async () => {});
    useVoxelStore.getState().open(voxelDoc());
    useProjectsStore.setState({
      store: fakeStore({ save }),
      currentId: "v1",
      currentName: "Bust",
    });

    await useProjectsStore.getState().save();

    expect(save).toHaveBeenCalledOnce();
    const [id, doc] = save.mock.calls[0] as unknown as [string, unknown];
    expect(id).toBe("v1");
    expect(doc).toEqual(voxelDoc()); // the sculpt, byte-for-byte
    expect(useProjectsStore.getState().status).toBe("saved");
    // The clean snapshot carries the voxel envelope and round-trips the doc.
    const snap = readRecovery()!;
    expect(snap.dirty).toBe(false);
    expect(voxelOfRecoveryDoc(snap.doc)).toEqual(voxelDoc());
  });

  it("saveAs() creates the project from the voxel doc and adopts its id", async () => {
    const create = vi.fn(async (name: string, _doc?: unknown) => meta("new-vox", name));
    const save = vi.fn(async (..._args: unknown[]) => {});
    useVoxelStore.getState().open(voxelDoc());
    useProjectsStore.setState({ store: fakeStore({ create, save }), currentName: "Untitled" });

    await useProjectsStore.getState().saveAs("Bust v2");

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![1]).toEqual(voxelDoc());
    expect(save.mock.calls[0]![1]).toEqual(voxelDoc()); // thumbnail-attach save too
    const st = useProjectsStore.getState();
    expect(st.currentId).toBe("new-vox");
    expect(st.currentName).toBe("Bust v2");
    expect(st.status).toBe("saved");
  });

  it("with no sculpt open, save() still persists the parametric document (unchanged path)", async () => {
    const save = vi.fn(async (..._args: unknown[]) => {});
    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01 } });
    useProjectsStore.setState({ store: fakeStore({ save }), currentId: "p1", currentName: "Part" });

    await useProjectsStore.getState().save();

    const doc = save.mock.calls[0]![1] as CadDocument;
    expect(doc.features).toHaveLength(1);
    expect((doc as { kind?: string }).kind).toBeUndefined();
  });
});

describe("projectsStore — recover() unwraps a voxel recovery envelope", () => {
  it("restores the sculpt into the voxel store + Sculpt workspace", async () => {
    // A dirty snapshot exactly as the autosave path writes it (envelope form).
    const w = await writeRecovery({
      doc: { features: [], params: {}, voxel: voxelDoc() } as unknown as CadDocument,
      name: "Bust",
      currentId: "v1",
      dirty: true,
      savedAt: 42,
    });
    expect(w).toEqual({ ok: true });
    useProjectsStore.setState({ recoverable: readRecovery() });

    useProjectsStore.getState().recover();

    const st = useProjectsStore.getState();
    expect(useVoxelStore.getState().doc).toEqual(voxelDoc());
    expect(useCadStore.getState().workspace).toBe("sculpt");
    expect(st.currentId).toBe("v1");
    expect(st.currentName).toBe("Bust");
    expect(st.status).toBe("recovered unsaved work");
    expect(st.recoverable).toBeNull();
    expect(readRecovery()).toBeNull(); // consumed
  });

  it("a parametric snapshot still recovers into the editor and closes any sculpt", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "box", name: "Box 1", params: { dx: 0.05 } }],
      params: {},
    };
    useVoxelStore.getState().open(voxelDoc());
    useCadStore.getState().setWorkspace("sculpt");
    useProjectsStore.setState({
      recoverable: { doc, name: "Part A", currentId: null, dirty: true, savedAt: 1 },
    });

    useProjectsStore.getState().recover();

    expect(useVoxelStore.getState().doc).toBeNull();
    expect(useCadStore.getState().workspace).toBe("design");
    expect(useCadStore.getState().features[0]!.type).toBe("box");
  });
});
