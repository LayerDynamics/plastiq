import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRecovery,
  hydrateRecovery,
  isQuotaError,
  readRecovery,
  writeRecovery,
  type RecoverySnapshot,
  type StepPayloadRef,
} from "./recovery.js";
import { getRecoveryPayload, pruneRecoveryPayloads } from "./recoveryPayloads.js";
import type { CadDocument } from "../store/types.js";

const doc: CadDocument = {
  features: [{ id: "f1", type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } }],
  params: {},
};

const snap = (over: Partial<RecoverySnapshot> = {}): RecoverySnapshot => ({
  doc,
  name: "P",
  currentId: null,
  dirty: true,
  savedAt: 1,
  ...over,
});

/** Install a plain-object localStorage so tests can read the RAW stored JSON
 * (the Node env has no localStorage; recovery falls back to a private Map). */
function stubLocalStorage(overrides: Partial<Storage> = {}): Record<string, string> {
  const bag: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => bag[k] ?? null,
    setItem: (k: string, v: string) => {
      bag[k] = v;
    },
    removeItem: (k: string) => {
      delete bag[k];
    },
    ...overrides,
  };
  return bag;
}

afterEach(async () => {
  clearRecovery();
  await pruneRecoveryPayloads(); // drop content-addressed payloads between cases
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("crash-recovery snapshot store (FR-40)", () => {
  it("round-trips a snapshot through the (memory-fallback) store", async () => {
    expect(readRecovery()).toBeNull();
    await writeRecovery(snap({ name: "Part A" }));
    const got = readRecovery()!;
    expect(got.dirty).toBe(true);
    expect(got.currentId).toBeNull();
    expect(got.name).toBe("Part A");
    expect(got.doc.features).toHaveLength(1);
  });

  it("a clean snapshot overwrites a dirty one (a successful save)", async () => {
    await writeRecovery(snap({ currentId: "id1", dirty: true }));
    await writeRecovery(snap({ currentId: "id1", dirty: false, savedAt: 2 }));
    expect(readRecovery()!.dirty).toBe(false);
  });

  it("clearRecovery removes the snapshot", async () => {
    await writeRecovery(snap());
    clearRecovery();
    expect(readRecovery()).toBeNull();
  });
});

describe("writeRecovery reports failure — never silent, never throws (Review #13)", () => {
  it("a successful write reports ok", async () => {
    expect(await writeRecovery(snap())).toEqual({ ok: true });
  });

  it("surfaces a QuotaExceededError as reason 'quota'", async () => {
    stubLocalStorage({
      setItem: () => {
        throw new DOMException("the quota has been exceeded", "QuotaExceededError");
      },
    });
    const r = await writeRecovery(snap());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("quota");
      expect(r.message).toContain("quota");
    }
  });

  it("surfaces any other storage failure as reason 'error' with its message", async () => {
    stubLocalStorage({
      setItem: () => {
        throw new Error("backing store detached");
      },
    });
    const r = await writeRecovery(snap());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("error");
      expect(r.message).toContain("backing store detached");
    }
  });

  it("isQuotaError classifies the quota dialects and rejects other errors", () => {
    expect(isQuotaError(new DOMException("x", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError(new DOMException("x", "NS_ERROR_DOM_QUOTA_REACHED"))).toBe(true);
    expect(isQuotaError(new Error("IndexedDB quota exceeded"))).toBe(true);
    expect(isQuotaError(new Error("network down"))).toBe(false);
    expect(isQuotaError("nope")).toBe(false);
  });
});

describe("snapshot compaction — large import payloads stored once, not re-serialized (Review #13)", () => {
  const stepText = `ISO-10303-21;\n${"DATA; #1=CARTESIAN_POINT(''); ".repeat(2000)}END-ISO-10303-21;\n`;
  const importDoc: CadDocument = {
    features: [
      { id: "f1", type: "importStep", name: "part.step", data: { step: stepText } },
      { id: "f2", type: "fillet", params: { radius: 0.001 } },
    ],
    params: {},
  };
  const KEY = "plastiq:recovery";
  const OPTS = { compactMinBytes: 1024 };

  it("externalizes the STEP text: the raw snapshot carries a stepRef, not the payload", async () => {
    const bag = stubLocalStorage();
    expect(await writeRecovery(snap({ doc: importDoc }), OPTS)).toEqual({ ok: true });

    const raw = bag[KEY]!;
    expect(raw).not.toContain("ISO-10303"); // the verbatim text is NOT in the snapshot
    expect(raw.length).toBeLessThan(stepText.length / 4); // materially smaller

    const stored = JSON.parse(raw) as RecoverySnapshot;
    const data = stored.doc.features[0]!.data!;
    expect(data["step"]).toBeUndefined();
    const ref = data["stepRef"] as StepPayloadRef;
    expect(typeof ref.hash).toBe("string");
    expect(ref.bytes).toBe(stepText.length);
    // ...and the payload itself landed once in the content-addressed store.
    expect(await getRecoveryPayload(ref.hash)).toBe(stepText);
    // The caller's document was not mutated by compaction.
    expect(importDoc.features[0]!.data!["step"]).toBe(stepText);
  });

  it("hydrateRecovery restores the exact document (rebuild-identical round-trip)", async () => {
    stubLocalStorage();
    await writeRecovery(snap({ doc: importDoc }), OPTS);
    const hydrated = await hydrateRecovery(readRecovery()!);
    expect(hydrated.doc).toEqual(importDoc); // byte-identical STEP text, ref removed
  });

  it("externalizes and hydrates an IGES import with the matching igesRef key", async () => {
    const bag = stubLocalStorage();
    const igesText = `IGES;\n${"entity-record; ".repeat(2000)}END;`;
    const igesDoc: CadDocument = {
      features: [{ id: "f1", type: "importIges", name: "part.igs", data: { iges: igesText } }],
      params: {},
    };
    await writeRecovery(snap({ doc: igesDoc }), OPTS);
    const stored = JSON.parse(bag[KEY]!) as RecoverySnapshot;
    const data = stored.doc.features[0]!.data!;
    expect(data["iges"]).toBeUndefined();
    expect(data["igesRef"]).toMatchObject({ bytes: igesText.length });
    expect(data["stepRef"]).toBeUndefined();
    expect((await hydrateRecovery(stored)).doc).toEqual(igesDoc);
  });

  it("compacts import payloads nested in a boolean tool subtree too", async () => {
    const bag = stubLocalStorage();
    const nested: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: 0.05, dy: 0.05, dz: 0.05 } },
        {
          id: "f2",
          type: "boolean",
          data: {
            op: "subtract",
            toolFeatures: [
              { id: "t1", type: "importStep", name: "tool.step", data: { step: stepText } },
            ],
          },
        },
      ],
      params: {},
    };
    await writeRecovery(snap({ doc: nested }), OPTS);
    expect(bag[KEY]!).not.toContain("ISO-10303");
    const hydrated = await hydrateRecovery(readRecovery()!);
    expect(hydrated.doc).toEqual(nested);
  });

  it("keeps a small import payload inline (below the threshold)", async () => {
    const bag = stubLocalStorage();
    const small: CadDocument = {
      features: [{ id: "f1", type: "importStep", data: { step: "ISO-10303-21; tiny" } }],
      params: {},
    };
    await writeRecovery(snap({ doc: small }), OPTS);
    const stored = JSON.parse(bag[KEY]!) as RecoverySnapshot;
    expect(stored.doc.features[0]!.data!["step"]).toBe("ISO-10303-21; tiny");
    expect(stored.doc.features[0]!.data!["stepRef"]).toBeUndefined();
  });

  it("a missing payload is NOT fabricated: hydration leaves the ref for a loud rebuild failure", async () => {
    stubLocalStorage();
    await writeRecovery(snap({ doc: importDoc }), OPTS);
    await pruneRecoveryPayloads(); // simulate the payload blob being lost
    const hydrated = await hydrateRecovery(readRecovery()!);
    const data = hydrated.doc.features[0]!.data!;
    expect(data["step"]).toBeUndefined(); // never invented
    expect(data["stepRef"]).toBeDefined(); // rebuild.ts reports this loudly
  });

  it("clearRecovery garbage-collects the content-addressed payloads", async () => {
    stubLocalStorage();
    await writeRecovery(snap({ doc: importDoc }), OPTS);
    const ref = storedImportRef();
    expect(await getRecoveryPayload(ref.hash)).toBe(stepText);
    clearRecovery();
    await vi.waitFor(async () => {
      expect(await getRecoveryPayload(ref.hash)).toBeNull();
    });
  });

  it("a compacted write garbage-collects payloads the snapshot no longer references", async () => {
    stubLocalStorage();
    await writeRecovery(snap({ doc: importDoc }), OPTS);
    const oldRef = storedImportRef();

    const otherText = `ISO-10303-21;\n${"#2=DIRECTION(''); ".repeat(2000)}END;`;
    const otherDoc: CadDocument = {
      features: [{ id: "f1", type: "importStep", data: { step: otherText } }],
      params: {},
    };
    await writeRecovery(snap({ doc: otherDoc }), OPTS);
    const newRef = storedImportRef();

    expect(await getRecoveryPayload(newRef.hash)).toBe(otherText); // current payload kept
    await vi.waitFor(async () => {
      expect(await getRecoveryPayload(oldRef.hash)).toBeNull(); // stale payload dropped
    });
  });

  it("falls back to an inline snapshot if the payload store fails (recovery stays complete)", async () => {
    const bag = stubLocalStorage();
    // Force putRecoveryPayload down the (throwing) IndexedDB path: an indexedDB
    // global whose open() rejects everything.
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => {
        const req: Record<string, unknown> = {};
        setTimeout(() => {
          (req["onerror"] as (() => void) | undefined)?.();
        }, 0);
        return req;
      },
    };
    try {
      const r = await writeRecovery(snap({ doc: importDoc }), OPTS);
      expect(r).toEqual({ ok: true }); // inline fallback landed
      expect(bag[KEY]!).toContain("ISO-10303"); // full text inlined
      const hydrated = await hydrateRecovery(readRecovery()!);
      expect(hydrated.doc).toEqual(importDoc);
    } finally {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  /** The stepRef of the import feature in the currently stored snapshot. */
  function storedImportRef(): StepPayloadRef {
    return readRecovery()!.doc.features.find((f) => f.type === "importStep")!.data![
      "stepRef"
    ] as StepPayloadRef;
  }
});
