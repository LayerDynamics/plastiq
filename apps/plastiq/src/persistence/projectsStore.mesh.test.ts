// Mesh-project persistence regressions — projectsStore routes `kind:"mesh"`
// documents through save/saveAs/recovery like it routes voxel docs (ADR-0010).
//
// The clobber bug these tests pin down: with a MESH project open (activeMeshDoc
// set), liveDocument() used to fall through to the parametric branch, so save()
// wrote `useCadStore.getState().toDocument()` — whatever the (unrelated, often
// empty) parametric editor held — over the mesh project's stored GLB: silent
// data loss on every save/autosave. Pre-fix, the first test failed with
// `save.mock.calls[0][1]` being `{ features: [...], params: {} }` (no `kind`)
// instead of the mesh document.
//
// Recovery has the same fall-through hazard: recovery.ts is typed over
// CadDocument and iterates `doc.features` (absent on a MeshDoc), so an
// UNwrapped mesh doc makes writeRecovery fail — mesh docs ride the same
// empty-features envelope voxel docs do, and recover() unwraps them into
// activeMeshDoc.

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meshOfRecoveryDoc, useProjectsStore } from "./projectsStore.js";
import { useCadStore } from "../store/store.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { clearRecovery, readRecovery, writeRecovery } from "./recovery.js";
import type { CadDocument, MeshDoc } from "../store/types.js";
import type { ProjectMeta, ProjectStore } from "./types.js";

const meshDoc = (): MeshDoc => ({
  kind: "mesh",
  name: "Generated widget",
  glb: "Z2xURgAAAAI=", // opaque base64 GLB payload; only byte-identity matters here
  source: { mode: "text3d", providerId: "fal:tripo", prompt: "a widget" },
});

const voxelDoc = () => ({
  kind: "voxel" as const,
  name: "Sculpt",
  dims: [4, 4, 4] as [number, number, number],
  voxelSize: 0.002,
  origin: [0, 0, 0] as [number, number, number],
  cells: [0, 5],
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

describe("projectsStore — save/saveAs persist the OPEN mesh document (clobber regression)", () => {
  it("save() with a mesh project open writes the mesh doc, NOT the parametric editor doc", async () => {
    const save = vi.fn(async (..._args: unknown[]) => {});
    // Unrelated content in the parametric editor — pre-fix, THIS is what save()
    // wrote over the mesh project's bytes.
    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01 } });
    useProjectsStore.setState({
      store: fakeStore({
        save,
        load: async () => ({ meta: meta("m1", "Widget"), doc: meshDoc() }),
      }),
    });

    await useProjectsStore.getState().open("m1");
    expect(useProjectsStore.getState().activeMeshDoc).toEqual(meshDoc());

    await useProjectsStore.getState().save();

    expect(save).toHaveBeenCalledOnce();
    const [id, doc] = save.mock.calls[0] as unknown as [string, MeshDoc];
    expect(id).toBe("m1");
    expect(doc).toEqual(meshDoc()); // the mesh, byte-for-byte — not `{ features, params }`
    expect(doc).not.toBe(useProjectsStore.getState().activeMeshDoc); // deep copy, no aliasing
    expect(useProjectsStore.getState().status).toBe("saved");
    // The clean recovery snapshot carries the mesh envelope and round-trips the doc
    // (an unwrapped MeshDoc would have made the snapshot write FAIL — see below).
    const snap = readRecovery()!;
    expect(snap.dirty).toBe(false);
    expect(meshOfRecoveryDoc(snap.doc)).toEqual(meshDoc());
  });

  it("saveAs() from an open mesh doc creates the project from the mesh and adopts its id", async () => {
    const create = vi.fn(async (name: string, _doc?: unknown) => meta("new-mesh", name));
    const save = vi.fn(async (..._args: unknown[]) => {});
    useProjectsStore.setState({
      store: fakeStore({ create, save }),
      activeMeshDoc: meshDoc(),
      currentName: "Untitled",
    });

    await useProjectsStore.getState().saveAs("Widget v2");

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![1]).toEqual(meshDoc());
    expect(save.mock.calls[0]![1]).toEqual(meshDoc()); // thumbnail-attach save too
    const st = useProjectsStore.getState();
    expect(st.currentId).toBe("new-mesh");
    expect(st.currentName).toBe("Widget v2");
    expect(st.status).toBe("saved");
    expect(meshOfRecoveryDoc(readRecovery()!.doc)).toEqual(meshDoc());
  });

  it("with no mesh doc open, save() still persists the parametric document (unchanged path)", async () => {
    const save = vi.fn(async (..._args: unknown[]) => {});
    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01 } });
    useProjectsStore.setState({ store: fakeStore({ save }), currentId: "p1", currentName: "Part" });

    await useProjectsStore.getState().save();

    const doc = save.mock.calls[0]![1] as CadDocument;
    expect(doc.features).toHaveLength(1);
    expect((doc as { kind?: string }).kind).toBeUndefined();
  });
});

describe("projectsStore — mesh documents survive crash recovery via the envelope", () => {
  it("an UNwrapped MeshDoc cannot be snapshotted (why the envelope exists)", async () => {
    // recovery.ts walks `doc.features` for import-payload compaction; a bare
    // MeshDoc has none, so the write reports failure instead of protecting work.
    const result = await writeRecovery({
      doc: meshDoc() as unknown as CadDocument,
      name: "Widget",
      currentId: "m1",
      dirty: true,
      savedAt: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("recover() unwraps a dirty mesh envelope into activeMeshDoc (no editor/voxel load)", async () => {
    const loadSpy = vi.spyOn(useCadStore.getState(), "loadDocument").mockImplementation(() => {});
    // Recovering from sculpt mode proves the mesh branch closes it + leaves Sculpt.
    useVoxelStore.getState().open(voxelDoc());
    useCadStore.getState().setWorkspace("sculpt");
    // A dirty snapshot exactly as toRecoveryDoc writes it (envelope form).
    const w = await writeRecovery({
      doc: { features: [], params: {}, mesh: meshDoc() } as unknown as CadDocument,
      name: "Widget",
      currentId: "m1",
      dirty: true,
      savedAt: 42,
    });
    expect(w).toEqual({ ok: true });
    useProjectsStore.setState({ recoverable: readRecovery() });

    useProjectsStore.getState().recover();

    const st = useProjectsStore.getState();
    expect(st.activeMeshDoc).toEqual(meshDoc()); // restored, JSON round-tripped verbatim
    expect(useVoxelStore.getState().doc).toBeNull();
    expect(useCadStore.getState().workspace).toBe("design");
    expect(loadSpy).not.toHaveBeenCalled(); // mesh docs bypass the B-rep editor
    expect(st.currentId).toBe("m1");
    expect(st.currentName).toBe("Widget");
    expect(st.status).toBe("recovered unsaved work");
    expect(st.recoverable).toBeNull();
    expect(readRecovery()).toBeNull(); // consumed
    loadSpy.mockRestore();
  });

  it("recovering a parametric snapshot clears a stale open mesh doc", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "box", name: "Box 1", params: { dx: 0.05 } }],
      params: {},
    };
    useProjectsStore.setState({
      activeMeshDoc: meshDoc(),
      recoverable: { doc, name: "Part A", currentId: null, dirty: true, savedAt: 1 },
    });

    useProjectsStore.getState().recover();

    expect(useProjectsStore.getState().activeMeshDoc).toBeNull(); // must not shadow the editor
    expect(useCadStore.getState().features[0]!.type).toBe("box");
  });
});
