// SPEC-6 R4.3/R29 — the create_mesh creative flow as the GenerationPanel assembles it:
// the paid-job confirm GATE + the real persist path (projectsStore.createMeshProject) +
// the post-loop OPEN that switches the panel to the new mesh document. Uses a FAKE mesh
// provider and injected fetch/validate so it runs in CI with no key and no network.
//
// Asserts the contract the panel depends on:
//   • the confirm gate fires before any billable call,
//   • a DECLINED job persists nothing (no project created),
//   • an APPROVED job persists a mesh project AND opening it sets activeMeshDoc.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMesh, type CreateMeshDeps } from "./tools/createMesh.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { MeshDoc, PersistedDoc } from "../store/types.js";
import type { ProjectMeta, Project, ProjectStore } from "../persistence/types.js";
import type { MeshGenJob, MeshGenProvider, MeshGenRequest, MeshGenStatus } from "./meshgen/types.js";

/** An in-memory ProjectStore that records created docs and can load them back (so the
 * panel's persist→open round-trip is real, without the SQLite WASM backend). */
function memoryStore(): ProjectStore {
  const rows = new Map<string, Project>();
  let n = 0;
  return {
    list: async () => [...rows.values()].map((r) => r.meta),
    load: async (id) => rows.get(id) ?? null,
    create: async (name, doc: PersistedDoc, units = "mm") => {
      const id = `mem-${++n}`;
      const meta: ProjectMeta = { id, name, units, created: n, updated: n, thumbnail: null };
      rows.set(id, { meta, doc });
      return meta;
    },
    save: async (id, doc) => {
      const cur = rows.get(id);
      if (cur) rows.set(id, { meta: cur.meta, doc });
    },
    rename: async () => {},
    delete: async (id) => {
      rows.delete(id);
    },
  };
}

/** A fake 3D-gen provider: one submit, then poll succeeds with a dummy GLB url. */
const fakeProvider: MeshGenProvider = {
  id: "fake:gen",
  label: "Fake",
  supports: { text3d: true, img3d: true },
  submit: async (_req: MeshGenRequest): Promise<MeshGenJob> => ({ id: "job-1" }),
  poll: async (): Promise<MeshGenStatus> => ({ state: "succeeded", glbUrl: "memory://glb" }),
};

function flowDeps(confirm: CreateMeshDeps["confirm"], recordPaidJob = vi.fn()): CreateMeshDeps {
  return {
    confirm,
    resolveMeshProvider: (id) => (id === "fake:gen" ? fakeProvider : undefined),
    fetchGlb: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    validateGlb: async () => {}, // accept the dummy bytes (no real importGltf in this test)
    persist: async (doc) => useProjectsStore.getState().createMeshProject(doc),
    recordPaidJob,
    delay: async () => {},
  };
}

afterEach(() => {
  globalThis.indexedDB = new IDBFactory();
  useProjectsStore.setState({ store: null, currentId: null, activeMeshDoc: null, currentName: "Untitled", status: "" });
});

describe("create_mesh creative flow (gate + persist + open)", () => {
  it("declined at the paid gate: persists nothing and records no billable job", async () => {
    useProjectsStore.setState({ store: memoryStore() });
    const confirm = vi.fn(async () => false);
    const recordPaidJob = vi.fn();

    const res = await createMesh(
      { mode: "text3d", prompt: "a low-poly rock", providerId: "fake:gen" },
      flowDeps(confirm, recordPaidJob),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith({ mode: "text3d", providerId: "fake:gen", billableCalls: 1 });
    expect(res.status).toBe("cancelled");
    expect(recordPaidJob).not.toHaveBeenCalled();
    // No project was created.
    expect(await useProjectsStore.getState().store!.list()).toHaveLength(0);
  });

  it("approved: persists a mesh project, and opening it switches the panel to the mesh doc", async () => {
    useProjectsStore.setState({ store: memoryStore() });
    const confirm = vi.fn(async () => true);

    const res = await createMesh(
      { mode: "text3d", prompt: "a low-poly rock", providerId: "fake:gen" },
      flowDeps(confirm),
    );

    expect(res.status).toBe("ok");
    expect(res.meshDocId).toBeDefined();
    // The mesh project is persisted but the panel has NOT switched yet (no focus steal).
    expect(useProjectsStore.getState().activeMeshDoc).toBeNull();
    const list = await useProjectsStore.getState().store!.list();
    expect(list).toHaveLength(1);

    // The panel opens it AFTER the loop → activeMeshDoc is the generated mesh.
    await useProjectsStore.getState().open(res.meshDocId!);
    const active = useProjectsStore.getState().activeMeshDoc as MeshDoc | null;
    expect(active?.kind).toBe("mesh");
    expect(active?.source).toMatchObject({ mode: "text3d", providerId: "fake:gen" });
  });
});
