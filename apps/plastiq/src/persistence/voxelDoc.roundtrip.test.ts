// ADR-0010 — a `kind:"voxel"` document is a full PersistedDoc member: it must
// round-trip byte-for-byte through every store backend (in-memory record store,
// real IndexedDB via fake-indexeddb, and the SQLite project store), exactly as
// persistedDoc.test.ts pins for MeshDoc. The stores treat documents as opaque
// payloads, so this guards the union widening end-to-end.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import { MemoryBlobStore, MemoryProjectRecordStore } from "./memory.js";
import { IdbProjectRecordStore } from "./idb.js";
import { createSqliteProjectStore } from "./sqlite.js";
import { isMeshDoc, isVoxelDoc, type VoxelDoc } from "../store/types.js";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

afterEach(() => {
  // Reset the global IDB so the "plastiq" database doesn't leak across cases.
  globalThis.indexedDB = new IDBFactory();
});

/** A sculpt document — compact occupied-cell indices; the store never parses them. */
const voxelDoc = (): VoxelDoc => ({
  kind: "voxel",
  name: "Sculpted Bust",
  dims: [32, 32, 32],
  voxelSize: 0.002,
  origin: [-0.032, -0.032, 0],
  cells: [0, 1, 33, 1024, 32767],
});

describe("VoxelDoc round-trips through every persistence backend (ADR-0010)", () => {
  it("MemoryProjectRecordStore preserves a VoxelDoc, deep-copied", async () => {
    const records = new MemoryProjectRecordStore();
    const input = voxelDoc();
    await records.putDoc("v", input);
    input.cells.push(99999); // mutate after storing — must not leak in
    const out = await records.getDoc("v");
    expect(out).toEqual(voxelDoc());
    expect(isVoxelDoc(out!)).toBe(true);
    expect(isMeshDoc(out!)).toBe(false);
  });

  it("the IndexedDB (structuredClone) backend round-trips a VoxelDoc", async () => {
    const records = new IdbProjectRecordStore();
    await records.putDoc("v", voxelDoc());
    const out = await records.getDoc("v");
    expect(out).toEqual(voxelDoc());
    expect(isVoxelDoc(out!)).toBe(true);
  });

  it("the SQLite project store round-trips a VoxelDoc through create/load", async () => {
    const store = await createSqliteProjectStore({
      SQL,
      blob: new MemoryBlobStore(),
      records: new MemoryProjectRecordStore(),
      now: () => 1,
      newId: () => "v1",
    });
    const meta = await store.create("Bust", voxelDoc());
    const loaded = await store.load(meta.id);
    expect(loaded?.doc).toEqual(voxelDoc());
    expect(isVoxelDoc(loaded!.doc)).toBe(true);
  });

  it("a voxel project persists + reloads across an independent SQLite re-open", async () => {
    const blob = new MemoryBlobStore();
    const records = new MemoryProjectRecordStore();
    const first = await createSqliteProjectStore({ SQL, blob, records, now: () => 1, newId: () => "v1" });
    await first.create("Bust", voxelDoc());

    // A brand-new store over the SAME durable backing must restore the sculpt.
    const reopened = await createSqliteProjectStore({ SQL, blob, records });
    const loaded = await reopened.load("v1");
    expect(isVoxelDoc(loaded!.doc)).toBe(true);
    expect(loaded?.doc).toEqual(voxelDoc());
  });
});
