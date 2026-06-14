// store/seed — SMOKE: defaultDocument runs and returns a well-formed document.

import { describe, expect, it } from "vitest";

import { defaultDocument } from "./seed.js";

describe("defaultDocument — smoke", () => {
  it("returns a document with a non-empty feature list and a params map", () => {
    const doc = defaultDocument();
    expect(Array.isArray(doc.features)).toBe(true);
    expect(doc.features.length).toBeGreaterThan(0);
    expect(typeof doc.params).toBe("object");
  });
});
