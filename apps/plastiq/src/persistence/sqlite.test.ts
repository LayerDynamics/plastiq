import { beforeAll, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import { createSqliteProjectStore } from "./sqlite.js";
import { MemoryBlobStore, MemoryProjectRecordStore } from "./memory.js";
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

/** A store with injected clock + ids for deterministic assertions. Returns the
 * shared blob (metadata index) + records (per-project payloads) so a re-opened
 * store can be built over the SAME durable backing. */
async function freshStore(
  blob = new MemoryBlobStore(),
  records = new MemoryProjectRecordStore(),
): Promise<{
  store: Awaited<ReturnType<typeof createSqliteProjectStore>>;
  blob: MemoryBlobStore;
  records: MemoryProjectRecordStore;
}> {
  let n = 0;
  const store = await createSqliteProjectStore({
    SQL,
    blob,
    records,
    now: () => 1000 + n,
    newId: () => `p${++n}`,
  });
  return { store, blob, records };
}

/** Build a pre-split "v1" image: a single SQLite file whose `projects` table
 * carries the document + thumbnail inline (the layout this store migrated away
 * from). `user_version` is left at its default 0 so the migration triggers. */
function oldFormatImage(name: string, d: CadDocument, thumbnail: string | null): Uint8Array {
  const db = new SQL.Database();
  db.run(
    `CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, units TEXT NOT NULL,
       created INTEGER NOT NULL, updated INTEGER NOT NULL, doc TEXT NOT NULL, thumbnail TEXT);`,
  );
  db.run(
    "INSERT INTO projects (id, name, units, created, updated, doc, thumbnail) VALUES (?,?,?,?,?,?,?)",
    ["legacy1", name, "mm", 100, 200, JSON.stringify(d), thumbnail],
  );
  const img = db.export();
  db.close();
  return img;
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
    expect((loaded!.doc as CadDocument).features[0]!.params).toEqual({ dx: 0.09, dy: 0.04, dz: 0.03 });
    expect(loaded?.meta.thumbnail).toBe("data:image/png;base64,AAAA");
    expect(loaded!.meta.updated).toBeGreaterThanOrEqual(meta.updated);
  });

  it("save with an undefined thumbnail leaves the existing thumbnail untouched", async () => {
    const { store } = await freshStore();
    const meta = await store.create("P", doc(0.06));
    await store.save(meta.id, doc(0.06), "data:image/png;base64,KEEP");
    await store.save(meta.id, doc(0.09)); // no thumbnail arg → must not clear it
    expect((await store.load(meta.id))?.meta.thumbnail).toBe("data:image/png;base64,KEEP");
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

  it("delete removes the project's payload from the record store (no orphan)", async () => {
    const { store, records } = await freshStore();
    const meta = await store.create("P", doc(0.06));
    await store.delete(meta.id);
    expect(await records.getDoc(meta.id)).toBeNull();
  });

  it("persists the DB image so a re-opened store sees the data (durability)", async () => {
    const blob = new MemoryBlobStore();
    const records = new MemoryProjectRecordStore();
    const first = await freshStore(blob, records);
    await first.store.create("Persisted", doc(0.06));

    // A brand-new store over the SAME blob + records must restore the project.
    const second = await createSqliteProjectStore({ SQL, blob, records });
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

  it("a rejected save to a deleted id does not orphan a payload record", async () => {
    const { store, records } = await freshStore();
    await expect(store.save("ghost", doc(0.09))).rejects.toThrow(/no project with id/);
    // The metadata guard runs before any payload write, so nothing was stored.
    expect(await records.getDoc("ghost")).toBeNull();
  });

  it("save still succeeds (and persists) for an existing id", async () => {
    const blob = new MemoryBlobStore();
    const records = new MemoryProjectRecordStore();
    const { store } = await freshStore(blob, records);
    const meta = await store.create("P", doc(0.06));
    await expect(store.save(meta.id, doc(0.09))).resolves.toBeUndefined();
    const reopened = await createSqliteProjectStore({ SQL, blob, records });
    expect(((await reopened.load(meta.id))!.doc as CadDocument).features[0]!.params).toEqual({
      dx: 0.09,
      dy: 0.04,
      dz: 0.03,
    });
  });
});

describe("SqliteProjectStore — incremental split persistence (Review Medium)", () => {
  it("keeps documents in the record store, NOT the re-serialized metadata index", async () => {
    const blob = new MemoryBlobStore();
    const records = new MemoryProjectRecordStore();
    const a = await createSqliteProjectStore({ SQL, blob, records, now: () => 1, newId: () => "x1" });
    await a.create("P", doc(0.06));

    // A store sharing only the index image (with a fresh, EMPTY record store)
    // sees the metadata but cannot load the document — proving the document is
    // not serialized into the per-mutation image. (If it were, this would load.)
    const indexOnly = await createSqliteProjectStore({
      SQL,
      blob,
      records: new MemoryProjectRecordStore(),
    });
    expect(await indexOnly.list()).toHaveLength(1); // metadata IS in the index
    await expect(indexOnly.load("x1")).rejects.toThrow(/document payload is missing/);
  });

  it("list() surfaces thumbnails warmed from the record store", async () => {
    const { store } = await freshStore();
    const meta = await store.create("P", doc(0.06));
    await store.save(meta.id, doc(0.06), "data:image/png;base64,WARM");
    expect((await store.list())[0]!.thumbnail).toBe("data:image/png;base64,WARM");
  });

  it("a thumbnail saved after the list is first warmed is still reflected", async () => {
    const { store } = await freshStore();
    const meta = await store.create("P", doc(0.06));
    await store.list(); // warms the (currently empty) thumbnail cache
    await store.save(meta.id, doc(0.06), "data:image/png;base64,LATE");
    expect((await store.list())[0]!.thumbnail).toBe("data:image/png;base64,LATE");
  });
});

describe("SqliteProjectStore — migration from a pre-split image", () => {
  it("moves inline doc/thumbnail into the record store and preserves the project", async () => {
    const original = doc(0.06);
    const blob = new MemoryBlobStore();
    await blob.save(oldFormatImage("Legacy", original, "data:image/png;base64,LEG"));
    const records = new MemoryProjectRecordStore();

    const store = await createSqliteProjectStore({ SQL, blob, records });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Legacy");
    expect(list[0]!.thumbnail).toBe("data:image/png;base64,LEG"); // thumbnail still shown
    const loaded = await store.load("legacy1");
    expect(loaded?.doc).toEqual(original);
    expect(loaded?.meta.thumbnail).toBe("data:image/png;base64,LEG");
    // The payload now lives in the record store (migrated out of the image).
    expect(await records.getDoc("legacy1")).toEqual(original);
    expect(await records.getThumbnail("legacy1")).toBe("data:image/png;base64,LEG");
  });

  it("a null legacy thumbnail migrates as null", async () => {
    const blob = new MemoryBlobStore();
    await blob.save(oldFormatImage("Legacy", doc(0.06), null));
    const records = new MemoryProjectRecordStore();
    const store = await createSqliteProjectStore({ SQL, blob, records });
    expect((await store.load("legacy1"))?.meta.thumbnail).toBeNull();
  });

  it("re-opening a migrated store does not lose data (migration is idempotent)", async () => {
    const blob = new MemoryBlobStore();
    await blob.save(oldFormatImage("Legacy", doc(0.06), "data:image/png;base64,LEG"));
    const records = new MemoryProjectRecordStore();
    await createSqliteProjectStore({ SQL, blob, records }); // migrates + persists v2 image
    const reopened = await createSqliteProjectStore({ SQL, blob, records });
    expect(await reopened.list()).toHaveLength(1);
    expect((await reopened.load("legacy1"))?.doc).toEqual(doc(0.06));
  });
});
