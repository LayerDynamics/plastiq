// Real-IndexedDB coverage for the content-addressed recovery payload store
// (Review #13). recovery.test.ts exercises the in-memory fallback (Node, no
// indexedDB); this file drives the real IDB code path — including the full
// compaction round-trip through recovery.ts — against fake-indexeddb, the same
// engine idb.test.ts uses for the project store.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import {
  getRecoveryPayload,
  hashPayload,
  pruneRecoveryPayloads,
  putRecoveryPayload,
} from "./recoveryPayloads.js";
import { clearRecovery, hydrateRecovery, readRecovery, writeRecovery } from "./recovery.js";
import type { CadDocument } from "../store/types.js";

afterEach(() => {
  clearRecovery();
  // Reset the global IDB so the "plastiq-recovery" DB doesn't leak across cases.
  globalThis.indexedDB = new IDBFactory();
});

describe("recovery payload store (real IndexedDB)", () => {
  it("put/get round-trips a payload by content hash", async () => {
    expect(await getRecoveryPayload("nope")).toBeNull();
    await putRecoveryPayload("abc123", "ISO-10303-21; payload");
    expect(await getRecoveryPayload("abc123")).toBe("ISO-10303-21; payload");
    // Idempotent overwrite (content-addressed: same key ⇒ same content).
    await putRecoveryPayload("abc123", "ISO-10303-21; payload");
    expect(await getRecoveryPayload("abc123")).toBe("ISO-10303-21; payload");
  });

  it("prune(keep) deletes only unreferenced payloads; prune() clears all", async () => {
    await putRecoveryPayload("keepme", "A");
    await putRecoveryPayload("dropme", "B");
    await pruneRecoveryPayloads(new Set(["keepme"]));
    expect(await getRecoveryPayload("keepme")).toBe("A");
    expect(await getRecoveryPayload("dropme")).toBeNull();

    await pruneRecoveryPayloads();
    expect(await getRecoveryPayload("keepme")).toBeNull();
  });

  it("hashPayload is deterministic and content-sensitive (SHA-256 when available)", async () => {
    const a1 = await hashPayload("same text");
    const a2 = await hashPayload("same text");
    const b = await hashPayload("same text!");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    // Known SHA-256 vector for the empty string (WebCrypto is present in Node).
    expect(await hashPayload("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("full compaction round-trip: snapshot payloads live in real IDB and hydrate back", async () => {
    const stepText = `ISO-10303-21;\n${"#1=CARTESIAN_POINT(''); ".repeat(4000)}END-ISO-10303-21;`;
    const doc: CadDocument = {
      features: [{ id: "f1", type: "importStep", name: "part.step", data: { step: stepText } }],
      params: {},
    };
    const r = await writeRecovery(
      { doc, name: "P", currentId: null, dirty: true, savedAt: 1 },
      { compactMinBytes: 1024 },
    );
    expect(r).toEqual({ ok: true });

    const stored = readRecovery()!;
    expect(JSON.stringify(stored.doc)).not.toContain("ISO-10303"); // externalized
    const hydrated = await hydrateRecovery(stored);
    expect(hydrated.doc).toEqual(doc); // byte-identical after real-IDB round-trip
  });
});
