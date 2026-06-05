// R6 — pluggable physics: every backend spawns a manifest and steps under gravity.

import { describe, expect, it } from "vitest";

import { PredictionSim, initSim } from "./prediction.js";
import type { BackendName } from "./engine.js";
import type { SimManifest } from "./manifest.js";

function dropManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "b0", mass: 1, com: [0, 0, 1], orientation: [0, 0, 0, 1], halfExtents: [0.05, 0.05, 0.05] },
    ],
    constraints: [],
  };
}

function hingeManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 1, com: [0, 0, 0], orientation: [0, 0, 0, 1], halfExtents: [0.05, 0.05, 0.05], fixed: true },
      { id: "b", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], halfExtents: [0.05, 0.05, 0.05] },
    ],
    constraints: [{ kind: "hinge", bodyA: "a", bodyB: "b", origin: [0.05, 0, 0], axis: [0, 1, 0] }],
  };
}

const BACKENDS: BackendName[] = ["rapier", "cannon", "ammo"];

describe.each(BACKENDS)("physics backend: %s", (backend) => {
  it("drops a free body under gravity (~½gt² over 1s)", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(60, 1n);
    const count = sim.spawnManifest(JSON.stringify(dropManifest()));
    expect(count).toBe(1);
    expect(sim.bodyCount).toBe(1);

    const z0 = sim.bodyPosition(0)[2];
    for (let i = 0; i < 60; i++) sim.stepDynamics();
    const z1 = sim.bodyPosition(0)[2];

    // After ~1s of free fall the body has dropped on the order of metres.
    expect(z1).toBeLessThan(z0 - 3);
    expect(z1).toBeGreaterThan(z0 - 7);
    sim.dispose();
  });

  it("spawns a 2-body hinge manifest (fixed base + swinging arm)", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(60, 1n);
    const count = sim.spawnManifest(JSON.stringify(hingeManifest()));
    expect(count).toBe(2);

    // The fixed base must not move; the arm swings under gravity.
    const base0 = sim.bodyPosition(0);
    for (let i = 0; i < 30; i++) sim.stepDynamics();
    const base1 = sim.bodyPosition(0);
    expect(base1[2]).toBeCloseTo(base0[2], 3); // base stayed put
    sim.dispose();
  });
});
