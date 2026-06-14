// store/seed — UNIT: defaultDocument is the fresh-session seed (one box feature).

import { describe, expect, it } from "vitest";

import { defaultDocument } from "./seed.js";

describe("defaultDocument (unit)", () => {
  it("is a single ~6×4×3 cm box feature with empty params", () => {
    const doc = defaultDocument();
    expect(doc.features).toHaveLength(1);
    const box = doc.features[0]!;
    expect(box.type).toBe("box");
    expect(box.params).toEqual({ dx: 0.06, dy: 0.04, dz: 0.03 }); // SI metres
    expect(doc.params).toEqual({});
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    expect(defaultDocument()).not.toBe(defaultDocument());
    expect(defaultDocument()).toEqual(defaultDocument());
  });
});
