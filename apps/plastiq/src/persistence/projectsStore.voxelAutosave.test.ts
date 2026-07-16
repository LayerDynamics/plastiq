// ADR-0010 wiring — the voxel autosave + crash-recovery TIMER path, driven through
// the REAL init()/wireAutosave/writeRecovery machinery (the sql.js projectStore and
// the aiStore are mocked, as in projectsStore.recovery.test.ts). A separate file so
// the module-level autosave wiring never leaks into the routing tests.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectsStore, voxelOfRecoveryDoc } from "./projectsStore.js";
import { useCadStore } from "../store/store.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { clearRecovery, readRecovery } from "./recovery.js";
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

describe("projectsStore — voxel edits drive the debounced recovery snapshot + autosave (FR-40)", () => {
  it("an edit writes a dirty voxel envelope at 500ms and autosaves the named project at 1500ms", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init(); // wires autosave (cad + voxel subscriptions)

    useProjectsStore.getState().newVoxelProject();
    useProjectsStore.setState({ currentId: "p1", currentName: "Bust" }); // a named sculpt project

    // A real sculpt edit — the voxel subscription schedules both timers.
    useVoxelStore.getState().setCell([0, 0, 5], true);
    const edited = useVoxelStore.getState().doc!;

    await vi.advanceTimersByTimeAsync(600); // recovery debounce (500ms)
    const dirty = readRecovery()!;
    expect(dirty.dirty).toBe(true);
    expect(dirty.currentId).toBe("p1");
    expect(voxelOfRecoveryDoc(dirty.doc)).toEqual(edited);

    await vi.advanceTimersByTimeAsync(1600); // autosave debounce (1500ms)
    expect(saveSpy).toHaveBeenCalled();
    expect(saveSpy.mock.calls[0]![0]).toBe("p1");
    expect(saveSpy.mock.calls[0]![1]).toEqual(edited); // the VoxelDoc itself persisted
    // …and the successful save wrote the CLEAN voxel snapshot.
    expect(readRecovery()!.dirty).toBe(false);
  });

  it("crash round-trip: edit → crash → init() surfaces the sculpt → recover() restores it", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init();

    useProjectsStore.getState().newVoxelProject();
    useVoxelStore.getState().setCell([1, 2, 3], true);
    const edited = useVoxelStore.getState().doc!;
    await vi.advanceTimersByTimeAsync(600); // the dirty snapshot lands

    // "Crash": tear down the live state; the recovery key survives (localStorage).
    useProjectsStore.setState({ store: null, recoverable: null, currentId: null, currentName: "Untitled" });
    useVoxelStore.getState().close();
    useCadStore.getState().setWorkspace("design");

    await useProjectsStore.getState().init(); // fresh launch
    const rec = useProjectsStore.getState().recoverable;
    expect(rec).toBeTruthy();
    expect(voxelOfRecoveryDoc(rec!.doc)).toEqual(edited);

    useProjectsStore.getState().recover();
    expect(useVoxelStore.getState().doc).toEqual(edited); // identical sculpt back
    expect(useCadStore.getState().workspace).toBe("sculpt");
    expect(useProjectsStore.getState().status).toBe("recovered unsaved work");
  });

  it("opening a sculpt project (busy) does NOT mark a dirty snapshot — only edits do", async () => {
    vi.useFakeTimers();
    await useProjectsStore.getState().init();
    clearRecovery();

    useProjectsStore.getState().newVoxelProject(); // busy-guarded open, no edit yet
    await vi.advanceTimersByTimeAsync(600);
    expect(readRecovery()).toBeNull();

    useVoxelStore.getState().setCell([0, 0, 5], true); // first real edit
    await vi.advanceTimersByTimeAsync(600);
    expect(readRecovery()!.dirty).toBe(true);
  });
});
