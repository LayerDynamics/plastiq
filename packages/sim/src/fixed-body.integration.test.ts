// Ground/fixed lowering, sim side — a body spawned with `fixed: true` is static:
// its pose must not move under gravity, while an identical unfixed body free-falls.
// The manifest mirrors what @plastiq/cad's exportForSim emits for a grounded
// component: the fixed body carries its REAL positive mass (backends key static
// purely off `fixed`, never off mass 0).

import { describe, expect, it } from "vitest";

import { PredictionSim, initSim } from "./prediction.js";
import type { HullCollider, SimManifest } from "./manifest.js";

function boxHull(h: number): HullCollider {
  return {
    points: [
      -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, // 0..3 bottom
      -h, -h, h, h, -h, h, h, h, h, -h, h, h, //     4..7 top
    ],
    faces: [
      [0, 3, 2], [0, 2, 1],
      [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4],
      [3, 7, 6], [3, 6, 2],
      [0, 4, 7], [0, 7, 3],
      [1, 2, 6], [1, 6, 5],
    ],
  };
}

const S = Math.SQRT1_2; // 90° about +Z is the quaternion [0,0,S,S]

// A grounded body (rotated, positive mass, fixed) beside an identical free body,
// far enough apart in x that they never collide. No constraints — pure gravity.
function groundedPairManifest(): SimManifest {
  return {
    version: 1,
    source: "test:grounded-pair",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "ground", mass: 61.6, com: [0, 0, 0.5], orientation: [0, 0, S, S], colliders: [boxHull(0.05)], fixed: true },
      { id: "loose", mass: 61.6, com: [0.4, 0, 0.5], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [],
  };
}

describe("fixed (grounded) body under gravity: mujoco", () => {
  it("a fixed body's pose stays put while an identical unfixed body falls", async () => {
    await initSim({ backend: "mujoco" });
    const sim = new PredictionSim(120, 1n);
    expect(sim.spawnManifest(JSON.stringify(groundedPairManifest()))).toBe(2);

    const groundStart = sim.bodyPosition(0);
    const looseStartZ = sim.bodyPosition(1)[2];
    for (let i = 0; i < 60; i++) sim.stepDynamics(); // 0.5 s

    // The grounded body has not moved OR rotated — despite its positive mass.
    const p = sim.bodyPosition(0);
    expect(p[0]).toBeCloseTo(groundStart[0], 6);
    expect(p[1]).toBeCloseTo(groundStart[1], 6);
    expect(p[2]).toBeCloseTo(groundStart[2], 6);
    const q = sim.bodyOrientation(0);
    expect(Math.abs(q[2])).toBeCloseTo(S, 6);
    expect(Math.abs(q[3])).toBeCloseTo(S, 6);

    // The identical unfixed body genuinely free-fell (½·9.81·0.5² ≈ 1.23 m).
    expect(sim.bodyPosition(1)[2]).toBeLessThan(looseStartZ - 0.5);
    sim.dispose();
  });
});
