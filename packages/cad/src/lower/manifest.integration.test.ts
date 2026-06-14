// isSimManifest — INTEGRATION: the guard's real job is validating EXTERNAL
// (serialized) data. A valid manifest survives a JSON round-trip and is accepted; a
// serialized object missing a field is rejected after parsing.

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

describe("isSimManifest — serialized-data validation (integration)", () => {
  it("accepts a manifest that survived JSON.stringify → JSON.parse", () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(valid()));
    expect(isSimManifest(roundTripped)).toBe(true);
  });

  it("rejects parsed JSON that is missing a required field", () => {
    const withoutGravity = valid();
    delete withoutGravity["gravity"];
    const parsed: unknown = JSON.parse(JSON.stringify(withoutGravity));
    expect(isSimManifest(parsed)).toBe(false);
  });
});
