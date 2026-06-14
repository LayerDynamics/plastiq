// manifest helpers — SMOKE tests. hullVolume + parseManifest invoked on a valid
// input (no-throw, sane result) and parseManifest on an invalid input (throws). The
// exhaustive validation matrix is in manifest.test.ts (unit); manifests flowing into
// a real spawn is covered by prediction.integration.test.ts.

import { describe, expect, it } from "vitest";

import { hullVolume, parseManifest } from "./manifest.js";
import { boxHull, freeBodyManifest } from "./backends/fixtures.js";

describe("manifest helpers — smoke", () => {
  it("hullVolume returns a positive volume for a box hull", () => {
    const v = hullVolume(boxHull(0.05)); // 0.1 m cube → 0.001 m³
    expect(v).toBeGreaterThan(0);
    expect(v).toBeCloseTo(0.001, 6);
  });

  it("parseManifest round-trips a valid manifest", () => {
    const m = parseManifest(JSON.stringify(freeBodyManifest()));
    expect(m.version).toBe(1);
    expect(m.bodies).toHaveLength(1);
  });

  it("parseManifest throws on malformed JSON / an invalid manifest", () => {
    expect(() => parseManifest("{ not json")).toThrow();
    expect(() => parseManifest(JSON.stringify({ version: 2 }))).toThrow();
  });
});
