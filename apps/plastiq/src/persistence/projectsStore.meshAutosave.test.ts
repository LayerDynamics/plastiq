// §2.12.3 — the MESH-document autosave + crash-recovery TIMER path, driven through the
// REAL init()/wireAutosave/writeRecovery machinery (the sql.js projectStore and the
// aiStore are mocked, exactly as in projectsStore.voxelAutosave.test.ts, which this
// mirrors for the third document kind).
//
// For a generated/sculpted mesh project the MESH is the document — it lives in the
// projects store's own `activeMeshDoc`, not the cad or voxel store — so before the fix
// the autosave wiring never saw sculpt edits at all: close the tab and every edit was
// gone, with no crash snapshot and no unsaved-changes prompt.

import { afterEach, describe, expect, it, vi } from "vitest";
import { meshOfRecoveryDoc, useProjectsStore } from "./projectsStore.js";
import { useCadStore } from "../store/store.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { clearRecovery, readRecovery } from "./recovery.js";
import type { MeshDoc } from "../store/types.js";
import type { ProjectStore } from "./types.js";

const saveSpy = vi.fn(async (..._args: unknown[]) => {});

vi.mock("./index.js", () => ({
  projectStore: async (): Promise<ProjectStore> => ({
    list: async () => [],
    load: async () => null,
    create: async (name: string) => ({
      id: "p1",
      name,
      units: "mm",
      created: 1,
      updated: 1,
      thumbnail: null,
    }),
    save: (...args: unknown[]) => saveSpy(...args),
    rename: async () => {},
    delete: async () => {},
  }),
}));

vi.mock("../ai/aiStore.js", () => ({
  useAiStore: {
    getState: () => ({
      openConversation: async () => {},
      deleteConversation: async () => {},
    }),
  },
}));

const MESH: MeshDoc = {
  kind: "mesh",
  name: "Blob",
  glb: "R0xCYmFzZQ==",
  source: { mode: "text3d", providerId: "fal:tripo" },
};

/** A sculpt edit, exactly as Viewport.onMeshBodiesChange writes it. */
function editMesh(glb: string): MeshDoc {
  const doc = useProjectsStore.getState().activeMeshDoc!;
  const edited: MeshDoc = { ...doc, glb };
  useProjectsStore.setState({ activeMeshDoc: edited, status: "mesh edited" });
  return edited;
}

afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
  saveSpy.mockClear();
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
});

describe("projectsStore — mesh edits drive the debounced recovery snapshot + autosave (§2.12.3)", () => {
  it("a sculpt edit writes a dirty mesh envelope at 500ms and autosaves the named project at 1500ms", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init(); // wires autosave (cad + voxel + mesh)

    // A named, already-open mesh project (the open path is busy-guarded below).
    useProjectsStore.setState({ activeMeshDoc: MESH, currentId: "p1", currentName: "Blob" });
    await vi.advanceTimersByTimeAsync(1700);
    saveSpy.mockClear();
    clearRecovery();

    const edited = editMesh("R0xCZWRpdGVk");

    await vi.advanceTimersByTimeAsync(600); // recovery debounce (500ms)
    const dirty = readRecovery()!;
    expect(dirty.dirty).toBe(true);
    expect(dirty.currentId).toBe("p1");
    expect(meshOfRecoveryDoc(dirty.doc)).toEqual(edited);

    await vi.advanceTimersByTimeAsync(1600); // autosave debounce (1500ms)
    expect(saveSpy).toHaveBeenCalled();
    expect(saveSpy.mock.calls[0]![0]).toBe("p1");
    expect(saveSpy.mock.calls[0]![1]).toEqual(edited); // the edited MeshDoc persisted
    expect(readRecovery()!.dirty).toBe(false); // the save wrote the CLEAN snapshot
  });

  it("crash round-trip: sculpt → crash → init() surfaces the mesh → recover() restores it", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init();

    useProjectsStore.setState({ activeMeshDoc: MESH });
    const edited = editMesh("R0xDcmFzaGVk");
    await vi.advanceTimersByTimeAsync(600); // the dirty snapshot lands

    // "Crash": tear down the live state; the recovery key survives (localStorage).
    useProjectsStore.setState({
      store: null,
      recoverable: null,
      currentId: null,
      currentName: "Untitled",
      activeMeshDoc: null,
    });

    await useProjectsStore.getState().init(); // fresh launch
    const rec = useProjectsStore.getState().recoverable;
    expect(rec).toBeTruthy();
    expect(meshOfRecoveryDoc(rec!.doc)).toEqual(edited);

    useProjectsStore.getState().recover();
    expect(useProjectsStore.getState().activeMeshDoc).toEqual(edited); // the sculpt is back
    expect(useProjectsStore.getState().status).toBe("recovered unsaved work");
  });

  it("OPENING a mesh project does NOT mark a dirty snapshot — only edits do", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init();
    clearRecovery();

    // open() clears `busy` in the SAME atomic set that installs the doc, so the
    // load's tail must not be mistaken for an edit.
    useProjectsStore.setState({ busy: true });
    useProjectsStore.setState({ activeMeshDoc: MESH, status: "opened", busy: false });
    await vi.advanceTimersByTimeAsync(600);
    expect(readRecovery()).toBeNull();

    editMesh("R0xCZmlyc3QtZWRpdA=="); // the first real edit
    await vi.advanceTimersByTimeAsync(600);
    expect(readRecovery()!.dirty).toBe(true);
  });

  it("leaving mesh mode (doc → null) is not an edit", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init();
    useProjectsStore.setState({ activeMeshDoc: MESH });
    await vi.advanceTimersByTimeAsync(600);
    clearRecovery();

    useProjectsStore.setState({ activeMeshDoc: null }); // converted to CAD / closed
    await vi.advanceTimersByTimeAsync(600);
    expect(readRecovery()).toBeNull();
  });
});
