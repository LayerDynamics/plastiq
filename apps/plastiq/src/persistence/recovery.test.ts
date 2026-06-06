import { afterEach, describe, expect, it } from "vitest";
import { clearRecovery, readRecovery, writeRecovery } from "./recovery.js";
import type { CadDocument } from "../store/types.js";

const doc: CadDocument = {
  features: [{ id: "f1", type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } }],
  params: {},
};

afterEach(() => clearRecovery());

describe("crash-recovery snapshot store (FR-40)", () => {
  it("round-trips a snapshot through the (memory-fallback) store", () => {
    expect(readRecovery()).toBeNull();
    writeRecovery({ doc, name: "Part A", currentId: null, dirty: true, savedAt: 123 });
    const got = readRecovery()!;
    expect(got.dirty).toBe(true);
    expect(got.currentId).toBeNull();
    expect(got.name).toBe("Part A");
    expect(got.doc.features).toHaveLength(1);
  });

  it("a clean snapshot overwrites a dirty one (a successful save)", () => {
    writeRecovery({ doc, name: "P", currentId: "id1", dirty: true, savedAt: 1 });
    writeRecovery({ doc, name: "P", currentId: "id1", dirty: false, savedAt: 2 });
    expect(readRecovery()!.dirty).toBe(false);
  });

  it("clearRecovery removes the snapshot", () => {
    writeRecovery({ doc, name: "P", currentId: null, dirty: true, savedAt: 1 });
    clearRecovery();
    expect(readRecovery()).toBeNull();
  });
});
