// Real-IndexedDB coverage for the persistence backings (SPEC-5 M5). The
// MemoryBlobStore-backed sqlite tests exercise the SQLite-side transform but NOT
// the IndexedDB layer or — critically — the v1→v2 schema upgrade that adds the
// `docs`/`thumbs` object stores to a returning user's existing v1 database and
// migrates its pre-split combined image into them. That upgrade runs in real
// browsers with data loss as the failure mode, so it is tested here against a
// real IDB engine (fake-indexeddb). Each test starts from a pristine factory.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import { IdbBlobStore, IdbProjectRecordStore } from "./idb.js";
import { createSqliteProjectStore } from "./sqlite.js";
import type { CadDocument } from "../store/types.js";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

afterEach(() => {
  // Reset the global IDB so the "plastiq" database doesn't leak across cases.
  globalThis.indexedDB = new IDBFactory();
});

const doc = (dx: number): CadDocument => ({
  features: [{ id: "f1", type: "box", name: "Box 1", params: { dx, dy: 0.04, dz: 0.03 } }],
  params: {},
  assembly: { instances: [], mates: [], joints: [] },
});

/** Build a pre-split combined image (the v1 `projects` table carried doc +
 * thumbnail inline, with `user_version` left at 0 so the migration triggers). */
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

/** Seed a real v1 "plastiq" database exactly as the original idb.ts created it:
 * version 1, a single `kv` store, the combined image under the `project-db` key.
 * No `docs`/`thumbs` stores — those are what the v2 upgrade must add. */
function seedV1Database(image: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("plastiq", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(image, "project-db");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("seed failed"));
      };
    };
    req.onerror = () => reject(req.error ?? new Error("seed open failed"));
  });
}

/** The object-store names of the current "plastiq" database (whatever version). */
function storeNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("plastiq");
    req.onsuccess = () => {
      const names = Array.from(req.result.objectStoreNames);
      req.result.close();
      resolve(names);
    };
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
}

describe("IdbBlobStore (real IndexedDB)", () => {
  it("save then load round-trips the image bytes", async () => {
    const store = new IdbBlobStore();
    expect(await store.load()).toBeNull();
    await store.save(new Uint8Array([1, 2, 3, 250]));
    expect(Array.from((await store.load())!)).toEqual([1, 2, 3, 250]);
  });
});

describe("IdbProjectRecordStore (real IndexedDB)", () => {
  it("round-trips documents and thumbnails, and deletes both", async () => {
    const records = new IdbProjectRecordStore();
    await records.putDoc("a", doc(0.05));
    await records.putThumbnail("a", "data:image/png;base64,A");
    await records.putDoc("b", doc(0.07));
    await records.putThumbnail("b", null);

    expect(await records.getDoc("a")).toEqual(doc(0.05));
    expect(await records.getThumbnail("a")).toBe("data:image/png;base64,A");

    const all = await records.allThumbnails();
    expect(all.get("a")).toBe("data:image/png;base64,A");
    expect(all.get("b")).toBeNull();
    expect(all.size).toBe(2);

    await records.delete("a");
    expect(await records.getDoc("a")).toBeNull();
    expect(await records.getThumbnail("a")).toBeNull();
  });
});

describe("createSqliteProjectStore over real IndexedDB", () => {
  it("fresh database: create/save/list/load persists across re-opened stores", async () => {
    const first = await createSqliteProjectStore({
      SQL,
      blob: new IdbBlobStore(),
      records: new IdbProjectRecordStore(),
      now: () => 5,
      newId: () => "fresh1",
    });
    await first.create("Bracket", doc(0.06));
    await first.save("fresh1", doc(0.06), "data:image/png;base64,T");

    // Brand-new store instances over the same real IDB must see the data.
    const reopened = await createSqliteProjectStore({
      SQL,
      blob: new IdbBlobStore(),
      records: new IdbProjectRecordStore(),
    });
    const list = await reopened.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Bracket");
    expect(list[0]!.thumbnail).toBe("data:image/png;base64,T");
    expect((await reopened.load("fresh1"))?.doc).toEqual(doc(0.06));

    expect((await storeNames()).sort()).toEqual(["docs", "kv", "thumbs"]);
  });

  it("v1→v2: upgrades the schema AND migrates a returning user's combined image", async () => {
    const original = doc(0.08);
    await seedV1Database(oldFormatImage("Legacy", original, "data:image/png;base64,LEG"));
    // The seeded DB is v1 with only the `kv` store — no docs/thumbs yet.
    expect((await storeNames()).sort()).toEqual(["kv"]);

    // Opening the store triggers the v1→v2 upgrade (adds docs/thumbs) and then the
    // image migration (moves the inline payload into those new stores).
    const store = await createSqliteProjectStore({
      SQL,
      blob: new IdbBlobStore(),
      records: new IdbProjectRecordStore(),
    });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Legacy");
    expect(list[0]!.thumbnail).toBe("data:image/png;base64,LEG");
    const loaded = await store.load("legacy1");
    expect(loaded?.doc).toEqual(original);
    expect(loaded?.meta.thumbnail).toBe("data:image/png;base64,LEG");

    // The upgrade created the new stores and the payload actually landed in them.
    expect((await storeNames()).sort()).toEqual(["docs", "kv", "thumbs"]);
    const records = new IdbProjectRecordStore();
    expect(await records.getDoc("legacy1")).toEqual(original);
    expect(await records.getThumbnail("legacy1")).toBe("data:image/png;base64,LEG");

    // A fully independent re-open (the migration persisted the shrunk v2 image).
    const reopened = await createSqliteProjectStore({
      SQL,
      blob: new IdbBlobStore(),
      records: new IdbProjectRecordStore(),
    });
    expect((await reopened.load("legacy1"))?.doc).toEqual(original);
  });
});
