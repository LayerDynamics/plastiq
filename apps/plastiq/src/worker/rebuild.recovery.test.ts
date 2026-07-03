// Rebuild-after-recovery fidelity (Review #13) — the hard invariant: a document
// whose importStep payload was externalized into the content-addressed recovery
// payload store and re-inflated by hydrateRecovery must rebuild the IDENTICAL
// solid with the real OCCT kernel; and a snapshot whose payload blob was lost
// must fail the rebuild loudly — geometry is never fabricated.

import { beforeAll, describe, expect, it } from "vitest";
import { exportStep, initOcct, makeBox, mm, type Occt } from "@plastiq/cad";
import { rebuildDocument, rebuildTagged } from "./rebuild.js";
import {
  clearRecovery,
  hydrateRecovery,
  readRecovery,
  writeRecovery,
} from "../persistence/recovery.js";
import type { CadDocument } from "../store/types.js";

const INIT_TIMEOUT_MS = 120_000;

describe("recovery round-trip of an imported STEP (Review #13)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("a compacted + hydrated snapshot rebuilds the identical imported solid", async () => {
    // Export a real box to STEP — the import feature's source of truth.
    const box = makeBox(oc, mm(20), mm(30), mm(40));
    const step = exportStep(oc, box);
    const volume = box.volume();
    box.delete();
    const doc: CadDocument = {
      features: [{ id: "f1", type: "importStep", name: "part.step", data: { step } }],
      params: {},
    };

    // Snapshot with compaction forced (any payload ≥16 bytes is externalized).
    const w = await writeRecovery(
      { doc, name: "P", currentId: null, dirty: true, savedAt: 1 },
      { compactMinBytes: 16 },
    );
    expect(w).toEqual({ ok: true });

    // The stored snapshot no longer re-serializes the verbatim STEP text…
    const stored = readRecovery()!;
    expect(JSON.stringify(stored.doc)).not.toContain("ISO-10303");

    // …but the hydrated document rebuilds the same solid, byte-for-byte input.
    const hydrated = await hydrateRecovery(stored);
    expect(hydrated.doc.features[0]!.data!["step"]).toBe(step);
    const solid = rebuildDocument(oc, hydrated.doc);
    expect(solid).not.toBeNull();
    try {
      expect(solid!.isValid()).toBe(true);
      expect(solid!.volume()).toBeCloseTo(volume, 9); // 20×30×40 mm box, in m³
    } finally {
      solid!.delete();
    }
    const mesh = rebuildTagged(oc, hydrated.doc, { linearDeflection: mm(0.5) });
    expect(mesh!.faceGroups).toHaveLength(6); // the box survived recovery intact

    clearRecovery();
  });

  it("an unresolved import payload ref fails the rebuild loudly (never fabricates)", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "importStep",
          name: "part.step",
          data: { stepRef: { hash: "deadbeefdeadbeef", bytes: 12345 } },
        },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(
      /recovered without its stored import payload/,
    );
  });

  it("a plain missing STEP text still reports the original error", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "importStep", data: {} }],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/missing STEP text/);
  });
});
