import { beforeAll, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import { createSqliteProjectStore } from "./sqlite.js";
import { MemoryBlobStore } from "./memory.js";
import type { CadDocument } from "../store/types.js";

let SQL: SqlJsStatic;
beforeAll(async () => {
  // In Node, sql.js resolves its wasm from the package dir (no locateFile needed).
  SQL = await initSqlJs();
});

const doc = (dx: number): CadDocument => ({
  features: [{ id: "f1", type: "box", name: "Box 1", params: { dx, dy: 0.04, dz: 0.03 } }],
  params: {},
  assembly: { instances: [], mates: [], joints: [] },
});

/** A store with injected clock + ids for deterministic assertions. */
async function freshStore(blob = new MemoryBlobStore()): Promise<{
  store: Awaited<ReturnType<typeof createSqliteProjectStore>>;
  blob: MemoryBlobStore;
}> {
  let n = 0;
  const store = await createSqliteProjectStore({
    SQL,
    blob,
    now: () => 1000 + n,
    newId: () => `p${++n}`,
  });
  return { store, blob };
}

describe("SqliteProjectStore — CRUD over real sql.js (SPEC-5 M5.1)", () => {
  it("creates, lists, and loads a project", async () => {
    const { store } = await freshStore();
    const meta = await store.create("Bracket", doc(0.06), "mm");
    expect(meta.id).toBe("p1");
    expect(meta.name).toBe("Bracket");
    const list = await store.list();
    expect(list).toHaveLength(1);
    const loaded = await store.load(meta.id);
    expect(loaded?.doc).toEqual(doc(0.06));
    expect(loaded?.meta.name).toBe("Bracket");
  });

  it("save overwrites the document + thumbnail and bumps updated", async () => {
    const { store } = await freshStore();
    const meta = await store.create("P", doc(0.06));
    await store.save(meta.id, doc(0.09), "data:image/png;base64,AAAA");
    const loaded = await store.load(meta.id);
    expect(loaded?.doc.features[0]!.params).toEqual({ dx: 0.09, dy: 0.04, dz: 0.03 });
    expect(loaded?.meta.thumbnail).toBe("data:image/png;base64,AAAA");
    expect(loaded!.meta.updated).toBeGreaterThanOrEqual(meta.updated);
  });

  it("rename + delete", async () => {
    const { store } = await freshStore();
    const meta = await store.create("Old", doc(0.06));
    await store.rename(meta.id, "New");
    expect((await store.load(meta.id))?.meta.name).toBe("New");
    await store.delete(meta.id);
    expect(await store.load(meta.id)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });

  it("persists the DB image so a re-opened store sees the data (durability)", async () => {
    const blob = new MemoryBlobStore();
    const first = await freshStore(blob);
    await first.store.create("Persisted", doc(0.06));

    // A brand-new store over the SAME blob must restore the persisted project.
    const second = await createSqliteProjectStore({ SQL, blob });
    const list = await second.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Persisted");
    expect((await second.load(list[0]!.id))?.doc).toEqual(doc(0.06));
  });

  it("a saved document round-trips byte-identically (FR-39)", async () => {
    const { store } = await freshStore();
    const original = doc(0.06);
    const meta = await store.create("RT", original);
    const reloaded = (await store.load(meta.id))!.doc;
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(original));
  });

  it("save to a non-existent id rejects instead of silently losing the document", async () => {
    const { store } = await freshStore();
    // No row matches → the UPDATE writes nothing. The old code resolved 'saved'
    // anyway; now it must reject so the caller never reports a phantom save.
    await expect(store.save("does-not-exist", doc(0.09))).rejects.toThrow(/no project with id/);
  });

  it("save still succeeds (and persists) for an existing id", async () => {
    const blob = new MemoryBlobStore();
    const { store } = await freshStore(blob);
    const meta = await store.create("P", doc(0.06));
    await expect(store.save(meta.id, doc(0.09))).resolves.toBeUndefined();
    const reopened = await createSqliteProjectStore({ SQL, blob });
    expect((await reopened.load(meta.id))?.doc.features[0]!.params).toEqual({
      dx: 0.09,
      dy: 0.04,
      dz: 0.03,
    });
  });
});
