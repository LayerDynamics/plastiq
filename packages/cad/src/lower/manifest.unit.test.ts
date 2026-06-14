// isSimManifest type guard — UNIT tests: accepts a well-formed manifest and rejects
// each way it can be malformed.

import { describe, expect, it } from "vitest";

import { isSimManifest } from "./manifest.js";

const validBody = (): Record<string, unknown> => ({
  id: "b0",
  mass: 1,
  com: [0, 0, 0],
  orientation: [0, 0, 0, 1],
  colliders: [{ points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], faces: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] }],
});
const valid = (): Record<string, unknown> => ({
  version: 1,
  source: "test",
  gravity: [0, 0, -9.81],
  bodies: [validBody()],
  constraints: [],
});
const bad = (overrides: Record<string, unknown>): unknown => ({ ...valid(), ...overrides });

describe("isSimManifest (unit)", () => {
  it("accepts a well-formed manifest", () => expect(isSimManifest(valid())).toBe(true));

  it("rejects non-objects", () => {
    expect(isSimManifest(null)).toBe(false);
    expect(isSimManifest(42)).toBe(false);
    expect(isSimManifest("manifest")).toBe(false);
  });

  it("rejects a wrong version / non-string source / malformed gravity", () => {
    expect(isSimManifest(bad({ version: 2 }))).toBe(false);
    expect(isSimManifest(bad({ source: 5 }))).toBe(false);
    expect(isSimManifest(bad({ gravity: [0, 0] }))).toBe(false);
  });

  it("rejects missing bodies / constraints arrays", () => {
    expect(isSimManifest(bad({ bodies: "x" }))).toBe(false);
    expect(isSimManifest(bad({ constraints: 0 }))).toBe(false);
  });

  it("rejects a body with a bad id/mass or no colliders", () => {
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), id: 1 }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), mass: "1" }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), colliders: [] }] }))).toBe(false);
  });
});
