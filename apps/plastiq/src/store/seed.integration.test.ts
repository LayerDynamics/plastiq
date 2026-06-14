// store/seed — INTEGRATION: the seed document loads into the REAL store and
// round-trips through toDocument (defaultDocument → loadDocument → toDocument).

import { describe, expect, it } from "vitest";

import { useCadStore } from "./store.js";
import { defaultDocument } from "./seed.js";

describe("defaultDocument — store round-trip (integration)", () => {
  it("loads into the real store and reads back as the same feature tree", () => {
    useCadStore.getState().loadDocument(defaultDocument());
    const doc = useCadStore.getState().toDocument();
    expect(doc.features).toHaveLength(1);
    expect(doc.features[0]!.type).toBe("box");
    expect(doc.features[0]!.params).toEqual({ dx: 0.06, dy: 0.04, dz: 0.03 });
  });
});
