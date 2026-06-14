// prediction — SMOKE test. The PredictionSim public API swept once on the REAL
// default backend (MuJoCo): constructor → spawnManifest → bodyCount → stepDynamics →
// bodyPosition / bodyOrientation → snapshot → restore → dispose, checked for no-throw
// + sane shapes. Behavioural depth (gravity, determinism, rewind) is in
// prediction.integration.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { PredictionSim, initSim } from "./prediction.js";
import { freeBodyManifest } from "./backends/fixtures.js";

const finite = (a: readonly number[]): boolean => a.every(Number.isFinite);

describe("PredictionSim — smoke (default backend)", () => {
  beforeAll(async () => {
    await initSim(); // MuJoCo default
  });

  it("the full wrapper API runs cleanly end to end", () => {
    const sim = new PredictionSim(60, 1n);
    expect(sim.spawnManifest(JSON.stringify(freeBodyManifest()))).toBe(1);
    expect(sim.bodyCount).toBe(1);

    expect(() => sim.stepDynamics()).not.toThrow();
    expect(finite(sim.bodyPosition(0))).toBe(true);
    expect(finite(sim.bodyOrientation(0))).toBe(true);

    const snap = sim.snapshot();
    expect(snap.bodies).toHaveLength(1);
    expect(() => sim.restore(snap)).not.toThrow();
    expect(() => sim.dispose()).not.toThrow();
  });
});
