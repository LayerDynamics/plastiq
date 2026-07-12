// Point-cloud project persistence (SPEC-13) — projectsStore routes `kind:"pointcloud"` documents
// through create/open/save/saveAs/recovery exactly like it routes mesh + voxel docs. These pin the
// two silent-corruption paths a new PersistedDoc member introduces (the advisor's #1/#2):
//   • save/saveAs with a cloud open must persist the CLOUD (liveDocument), not the empty parametric
//     editor doc — the same clobber the mesh branch fixed.
//   • a crash snapshot must round-trip the cloud through the recovery ENVELOPE (recovery.ts iterates
//     doc.features, absent on a PointCloudDoc), and recover() must unwrap it into activePointCloudDoc.
// The save→recover→open round-trip is the real test of the union member; guard/renderer unit tests
// never exercise these persistence boundaries.

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointCloudOfRecoveryDoc, useProjectsStore } from "./projectsStore.js";
import { useCadStore } from "../store/store.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { clearRecovery, readRecovery, writeRecovery } from "./recovery.js";
import type { CadDocument, PointCloudDoc } from "../store/types.js";
import type { ProjectMeta, ProjectStore } from "./types.js";

const cloudDoc = (): PointCloudDoc => ({
  kind: "pointcloud",
  name: "Scan cloud",
  points: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  colors: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  source: { mode: "photos3d", providerId: "photogrammetry" },
});

function meta(id: string, name = "P"): ProjectMeta {
  return { id, name, units: "mm", created: 1, updated: 1, thumbnail: null };
}

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
    activePointCloudDoc: null,
    recoverable: null,
    busy: false,
  });
  useVoxelStore.getState().close();
  useCadStore.getState().reset();
  clearRecovery();
  vi.restoreAllMocks();
});

describe("projectsStore — open/create route point-cloud documents", () => {
  it("open() holds a cloud project as activePointCloudDoc, leaving the parametric editor empty", async () => {
    useProjectsStore.setState({
      store: fakeStore({ load: async () => ({ meta: meta("c1", "Cloud"), doc: cloudDoc() }) }),
      activeMeshDoc: null,
    });

    await useProjectsStore.getState().open("c1");

    const st = useProjectsStore.getState();
    expect(st.activePointCloudDoc).toEqual(cloudDoc());
    expect(st.activeMeshDoc).toBeNull(); // mutually exclusive
    expect(st.currentId).toBe("c1");
  });

  it("createPointCloudProject persists the cloud and returns its id (does NOT open it)", async () => {
    const create = vi.fn(async (name: string, _doc?: unknown) => meta("new-cloud", name));
    useProjectsStore.setState({ store: fakeStore({ create }) });

    const id = await useProjectsStore.getState().createPointCloudProject(cloudDoc());

    expect(id).toBe("new-cloud");
    expect(create.mock.calls[0]![1]).toEqual(cloudDoc());
    expect(useProjectsStore.getState().activePointCloudDoc).toBeNull(); // not switched
  });

  it("opening a mesh/parametric project clears a stale open cloud (mutual exclusivity)", async () => {
    useProjectsStore.setState({
      store: fakeStore({ load: async () => ({ meta: meta("p2"), doc: { features: [], params: {} } }) }),
      activePointCloudDoc: cloudDoc(),
    });

    await useProjectsStore.getState().open("p2");

    expect(useProjectsStore.getState().activePointCloudDoc).toBeNull();
  });
});

describe("projectsStore — save persists the OPEN cloud (clobber regression)", () => {
  it("save() with a cloud open writes the cloud doc, NOT the parametric editor doc", async () => {
    const save = vi.fn(async (..._args: unknown[]) => {});
    useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01 } }); // unrelated editor content
    useProjectsStore.setState({
      store: fakeStore({ save, load: async () => ({ meta: meta("c1", "Cloud"), doc: cloudDoc() }) }),
    });

    await useProjectsStore.getState().open("c1");
    await useProjectsStore.getState().save();

    expect(save).toHaveBeenCalledOnce();
    const [id, doc] = save.mock.calls[0] as unknown as [string, PointCloudDoc];
    expect(id).toBe("c1");
    expect(doc).toEqual(cloudDoc()); // the cloud, not `{ features, params }`
    expect(doc).not.toBe(useProjectsStore.getState().activePointCloudDoc); // deep copy, no aliasing
    expect(useProjectsStore.getState().status).toBe("saved");
    const snap = readRecovery()!;
    expect(snap.dirty).toBe(false);
    expect(pointCloudOfRecoveryDoc(snap.doc)).toEqual(cloudDoc());
  });
});

describe("projectsStore — point clouds survive crash recovery via the envelope", () => {
  it("an UNwrapped PointCloudDoc cannot be snapshotted (why the envelope exists)", async () => {
    const result = await writeRecovery({
      doc: cloudDoc() as unknown as CadDocument,
      name: "Cloud",
      currentId: "c1",
      dirty: true,
      savedAt: 1,
    });
    expect(result.ok).toBe(false); // recovery.ts walks doc.features, absent on a cloud
  });

  it("recover() unwraps a dirty cloud envelope into activePointCloudDoc (no editor/voxel load)", async () => {
    const loadSpy = vi.spyOn(useCadStore.getState(), "loadDocument").mockImplementation(() => {});
    const w = await writeRecovery({
      doc: { features: [], params: {}, pointCloud: cloudDoc() } as unknown as CadDocument,
      name: "Cloud",
      currentId: "c1",
      dirty: true,
      savedAt: 42,
    });
    expect(w).toEqual({ ok: true });
    useProjectsStore.setState({ recoverable: readRecovery() });

    useProjectsStore.getState().recover();

    const st = useProjectsStore.getState();
    expect(st.activePointCloudDoc).toEqual(cloudDoc()); // restored, JSON round-tripped verbatim
    expect(st.activeMeshDoc).toBeNull();
    expect(loadSpy).not.toHaveBeenCalled(); // clouds bypass the B-rep editor
    expect(st.currentId).toBe("c1");
    expect(st.status).toBe("recovered unsaved work");
    expect(readRecovery()).toBeNull(); // consumed
    loadSpy.mockRestore();
  });

  it("recovering a parametric snapshot clears a stale open cloud", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "box", name: "Box 1", params: { dx: 0.05 } }],
      params: {},
    };
    useProjectsStore.setState({
      activePointCloudDoc: cloudDoc(),
      recoverable: { doc, name: "Part A", currentId: null, dirty: true, savedAt: 1 },
    });

    useProjectsStore.getState().recover();

    expect(useProjectsStore.getState().activePointCloudDoc).toBeNull(); // must not shadow the editor
    expect(useCadStore.getState().features[0]!.type).toBe("box");
  });
});
