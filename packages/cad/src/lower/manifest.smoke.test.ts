// isSimManifest — SMOKE: returns a boolean for valid input and for garbage.

import { describe, expect, it } from "vitest";

import { isSimManifest } from "./manifest.js";

const valid = (): Record<string, unknown> => ({
  version: 1,
  source: "test",
  gravity: [0, 0, -9.81],
  bodies: [
    {
      id: "b0",
      mass: 1,
      com: [0, 0, 0],
      orientation: [0, 0, 0, 1],
      colliders: [{ points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], faces: [[0, 1, 2]] }],
    },
  ],
  constraints: [],
});

describe("isSimManifest — smoke", () => {
  it("returns true for a valid manifest and false for garbage", () => {
    expect(isSimManifest(valid())).toBe(true);
    expect(isSimManifest({})).toBe(false);
    expect(isSimManifest(undefined)).toBe(false);
  });
});
