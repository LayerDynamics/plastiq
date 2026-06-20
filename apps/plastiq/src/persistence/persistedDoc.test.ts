// SPEC-6 R4.2 — the persisted document is a discriminated union (parametric
// CadDocument | generated MeshDoc). The store backends treat a document as an
// opaque payload, so a MeshDoc must round-trip byte-for-byte through every
// backing (in-memory record store, the SQLite project store, and real
// IndexedDB) and a *kind-less* document must still load as parametric
// (back-compat for libraries written before mesh documents existed).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import { MemoryBlobStore, MemoryProjectRecordStore } from "./memory.js";
import { IdbProjectRecordStore } from "./idb.js";
import { createSqliteProjectStore } from "./sqlite.js";
import { isMeshDoc, type CadDocument, type MeshDoc } from "../store/types.js";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

afterEach(() => {
  // Reset the global IDB so the "plastiq" database doesn't leak across cases.
  globalThis.indexedDB = new IDBFactory();
});

/** A generated mesh document. `glb` is an opaque base64 blob the store never
 * parses (geometry is re-derived via importGltf on load), so any bytes serve. */
const meshDoc = (): MeshDoc => ({
  kind: "mesh",
  name: "Generated Vase",
  glb: "Z2xURgIAAAABBQ==",
  source: { mode: "text3d", providerId: "fal:tripo", prompt: "a vase" },
});

/** A parametric document with no `kind` discriminant (the pre-R4.2 shape). */
const paramDoc = (): CadDocument => ({
  features: [{ id: "f1", type: "box", name: "Box 1", params: { dx: 0.05 } }],
  params: {},
});

describe("PersistedDoc union round-trips through every backend (SPEC-6 R4.2)", () => {
  it("MemoryProjectRecordStore preserves a MeshDoc (kind/glb/source), deep-copied", async () => {
    const records = new MemoryProjectRecordStore();
    const input = meshDoc();
    await records.putDoc("m", input);
    input.name = "MUTATED"; // mutate the source after storing — must not leak in
    const out = await records.getDoc("m");
    expect(out).toEqual(meshDoc());
    expect(isMeshDoc(out!)).toBe(true);
  });

  it("the IndexedDB (structuredClone) backend round-trips a MeshDoc", async () => {
    const records = new IdbProjectRecordStore();
    await records.putDoc("m", meshDoc());
    const out = await records.getDoc("m");
    expect(out).toEqual(meshDoc());
    expect(isMeshDoc(out!)).toBe(true);
  });

  it("the SQLite project store round-trips a MeshDoc through create/load", async () => {
    const store = await createSqliteProjectStore({
      SQL,
      blob: new MemoryBlobStore(),
      records: new MemoryProjectRecordStore(),
      now: () => 1,
      newId: () => "p1",
    });
    const meta = await store.create("Vase", meshDoc());
    const loaded = await store.load(meta.id);
    expect(loaded?.doc).toEqual(meshDoc());
    expect(isMeshDoc(loaded!.doc)).toBe(true);
  });

  it("a mesh project persists + reloads across an independent SQLite re-open", async () => {
    const blob = new MemoryBlobStore();
    const records = new MemoryProjectRecordStore();
    const first = await createSqliteProjectStore({ SQL, blob, records, now: () => 1, newId: () => "p1" });
    await first.create("Vase", meshDoc());

    // A brand-new store over the SAME durable backing must restore the mesh doc.
    const reopened = await createSqliteProjectStore({ SQL, blob, records });
    const loaded = await reopened.load("p1");
    expect(isMeshDoc(loaded!.doc)).toBe(true);
    expect(loaded?.doc).toEqual(meshDoc());
  });

  it("back-compat: a kind-less document round-trips and is treated as parametric", async () => {
    const records = new MemoryProjectRecordStore();
    await records.putDoc("p", paramDoc());
    const out = await records.getDoc("p");
    expect(out).toEqual(paramDoc());
    expect(isMeshDoc(out!)).toBe(false); // absent `kind` ⇒ parametric
  });
});
