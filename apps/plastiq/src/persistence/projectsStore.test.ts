// Regression coverage for the Review "High" finding: persistence write failures
// were silently swallowed. `save()`/`saveAs()` set status "saving…" then awaited
// `store.save(...)` with no try/catch, and every caller (the autosave timer + the
// Save buttons) invokes them as `void` — so a rejection became an unhandled promise:
// the status stuck on "saving…" forever and the user never learned their work didn't
// persist. These tests drive a throwing ProjectStore through the real store and pin
// the fixed behavior: the call resolves (no unhandled rejection), the failure surfaces
// on the status line, and the prior *dirty* recovery snapshot survives so a crash is
// still recoverable. projectsStore previously had zero colocated tests (the only
// substantial app module without one) — this is its first.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectsStore } from "./projectsStore.js";
import { useCadStore } from "../store/store.js";
import { clearRecovery, readRecovery, writeRecovery } from "./recovery.js";
import type { CadDocument, MeshDoc } from "../store/types.js";
import type { ProjectMeta, ProjectStore } from "./types.js";

const doc: CadDocument = { features: [], params: {} };

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
  // useProjectsStore is a module singleton — reset the fields these tests touch so
  // they don't leak across cases (and clear the localStorage/memory recovery key).
  useProjectsStore.setState({
    store: null,
    currentId: null,
    currentName: "Untitled",
    status: "",
    activeMeshDoc: null,
    busy: false,
  });
  clearRecovery();
});

describe("projectsStore — save failures are surfaced, never swallowed (Review High)", () => {
  it("save(): a rejecting backend resolves and reports 'save failed' instead of sticking on 'saving…'", async () => {
    const err = new Error("save: no project with id 'p1' — nothing was written");
    useProjectsStore.setState({
      store: fakeStore({
        save: async () => {
          throw err;
        },
      }),
      currentId: "p1",
      currentName: "Part A",
    });

    // The autosave path runs `void get().save()`: a rejection here would be an
    // unhandled promise. The fix folds it into the status line, so save() resolves.
    await expect(useProjectsStore.getState().save()).resolves.toBeUndefined();

    const { status } = useProjectsStore.getState();
    expect(status).not.toBe("saving…");
    expect(status).toContain("save failed");
    expect(status).toContain("nothing was written"); // the real reason is surfaced
  });

  it("save(): a failed write leaves the prior DIRTY recovery snapshot intact (crash still recoverable)", async () => {
    writeRecovery({ doc, name: "Part A", currentId: "p1", dirty: true, savedAt: 1 });
    useProjectsStore.setState({
      store: fakeStore({
        save: async () => {
          throw new Error("QuotaExceededError");
        },
      }),
      currentId: "p1",
      currentName: "Part A",
    });

    await useProjectsStore.getState().save();

    // The clean writeRecovery({dirty:false}) lives *after* the failing await, so it
    // never ran — the recoverable dirty snapshot must survive the failed save.
    expect(readRecovery()!.dirty).toBe(true);
  });

  it("save(): a successful write reports 'saved' and writes a CLEAN recovery snapshot", async () => {
    writeRecovery({ doc, name: "Part A", currentId: "p1", dirty: true, savedAt: 1 });
    const save = vi.fn(async () => {});
    useProjectsStore.setState({
      store: fakeStore({ save }),
      currentId: "p1",
      currentName: "Part A",
    });

    await useProjectsStore.getState().save();

    expect(save).toHaveBeenCalledOnce();
    expect(useProjectsStore.getState().status).toBe("saved");
    expect(readRecovery()!.dirty).toBe(false); // a successful save marks it clean
  });

  it("saveAs(): a rejecting backend resolves with 'save failed' and keeps the dirty snapshot", async () => {
    writeRecovery({ doc, name: "Untitled", currentId: null, dirty: true, savedAt: 1 });
    // create() succeeds but the follow-up save() (the thumbnail attach) rejects —
    // saveAs wraps both create and save, so either rejection must be caught.
    useProjectsStore.setState({
      store: fakeStore({
        save: async () => {
          throw new Error("quota exceeded");
        },
      }),
      currentName: "Untitled",
    });

    await expect(useProjectsStore.getState().saveAs("Part B")).resolves.toBeUndefined();

    const { status } = useProjectsStore.getState();
    expect(status).toContain("save failed");
    expect(status).toContain("quota exceeded");
    expect(readRecovery()!.dirty).toBe(true);
  });

  it("saveAs(): a successful create+save reports 'saved' and adopts the new project id", async () => {
    const create = vi.fn(async (name: string) => meta("new-id", name));
    useProjectsStore.setState({ store: fakeStore({ create }), currentName: "Untitled" });

    await useProjectsStore.getState().saveAs("Part B");

    expect(create).toHaveBeenCalledOnce();
    const st = useProjectsStore.getState();
    expect(st.currentId).toBe("new-id");
    expect(st.currentName).toBe("Part B");
    expect(st.status).toBe("saved");
    expect(readRecovery()!.dirty).toBe(false);
  });
});

describe("projectsStore — open() routes mesh vs parametric documents (SPEC-6 R4.2)", () => {
  const meshProjectDoc: MeshDoc = {
    kind: "mesh",
    name: "Vase",
    glb: "Z2xURgIAAAA=",
    source: { mode: "text3d", providerId: "fal:tripo", prompt: "a vase" },
  };

  it("opening a MESH project sets activeMeshDoc and does NOT load the parametric editor", async () => {
    // Stub loadDocument so a buggy call can't throw — we assert it is never called.
    const loadSpy = vi.spyOn(useCadStore.getState(), "loadDocument").mockImplementation(() => {});
    useProjectsStore.setState({
      store: fakeStore({ load: async () => ({ meta: meta("m1", "Vase"), doc: meshProjectDoc }) }),
    });

    await useProjectsStore.getState().open("m1");

    const st = useProjectsStore.getState();
    expect(st.activeMeshDoc).toEqual(meshProjectDoc);
    expect(st.currentId).toBe("m1");
    expect(st.currentName).toBe("Vase");
    expect(st.status).toBe("opened");
    expect(st.busy).toBe(false);
    expect(loadSpy).not.toHaveBeenCalled(); // mesh docs bypass the B-rep editor
    loadSpy.mockRestore();
  });

  it("opening a PARAMETRIC project loads the editor and clears any stale activeMeshDoc", async () => {
    const paramProjectDoc: CadDocument = { features: [], params: {} };
    const loadSpy = vi.spyOn(useCadStore.getState(), "loadDocument").mockImplementation(() => {});
    // Pre-set a stale mesh doc to prove opening a parametric project clears it.
    useProjectsStore.setState({
      store: fakeStore({ load: async () => ({ meta: meta("p9", "Bracket"), doc: paramProjectDoc }) }),
      activeMeshDoc: meshProjectDoc,
    });

    await useProjectsStore.getState().open("p9");

    const st = useProjectsStore.getState();
    expect(loadSpy).toHaveBeenCalledWith(paramProjectDoc);
    expect(st.activeMeshDoc).toBeNull();
    expect(st.currentId).toBe("p9");
    expect(st.currentName).toBe("Bracket");
    expect(st.status).toBe("opened");
    expect(st.busy).toBe(false);
    loadSpy.mockRestore();
  });

  it("opening a missing project reports 'project not found'", async () => {
    useProjectsStore.setState({ store: fakeStore({ load: async () => null }) });
    await useProjectsStore.getState().open("ghost");
    expect(useProjectsStore.getState().status).toBe("project not found");
  });
});
