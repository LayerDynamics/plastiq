// R6 — pluggable physics: every backend spawns a manifest and steps under gravity.

import { describe, expect, it } from "vitest";

import { PredictionSim, initSim } from "./prediction.js";
import type { BackendName } from "./engine.js";
import type { HullCollider, SimManifest } from "./manifest.js";

/** A box convex hull (8 corners + 12 outward-wound triangles) of the given half-extents. */
function boxHullXYZ(hx: number, hy: number, hz: number): HullCollider {
  return {
    points: [
      -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz, // 0..3 bottom
      -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz, //     4..7 top
    ],
    faces: [
      [0, 3, 2], [0, 2, 1], // −z
      [4, 5, 6], [4, 6, 7], // +z
      [0, 1, 5], [0, 5, 4], // −y
      [3, 7, 6], [3, 6, 2], // +y
      [0, 4, 7], [0, 7, 3], // −x
      [1, 2, 6], [1, 6, 5], // +x
    ],
  };
}

/** A cube convex hull of half-extent h. */
function boxHull(h: number): HullCollider {
  return boxHullXYZ(h, h, h);
}

function restManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      // A fixed 2×2×0.1 m ground slab; its top surface is at z = 0.05.
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], hull: boxHullXYZ(1, 1, 0.05), fixed: true },
      // A 0.1 m cube dropped from z = 0.5.
      { id: "cube", mass: 1, com: [0, 0, 0.5], orientation: [0, 0, 0, 1], hull: boxHull(0.05) },
    ],
    constraints: [],
  };
}

function dropManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [{ id: "b0", mass: 1, com: [0, 0, 1], orientation: [0, 0, 0, 1], hull: boxHull(0.05) }],
    constraints: [],
  };
}

function hingeManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 1, com: [0, 0, 0], orientation: [0, 0, 0, 1], hull: boxHull(0.05), fixed: true },
      { id: "b", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], hull: boxHull(0.05) },
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

  it("a convex-hull body falls and RESTS on a ground plane (hull collision works)", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(120, 1n);
    expect(sim.spawnManifest(JSON.stringify(restManifest()))).toBe(2);

    // Settle for ~2.5 s of sim time.
    for (let i = 0; i < 300; i++) sim.stepDynamics();
    const cubeZ = sim.bodyPosition(1)[2];

    // The 0.1 m cube's COM must come to rest just above the ground top (z=0.05),
    // i.e. ~0.10 — it did NOT tunnel through (would be far negative) and did NOT
    // hover (would still be ~0.5). This only holds if the convex hull collides.
    // (The upper bound allows a few mm of soft-contact gap across engines.)
    expect(cubeZ).toBeGreaterThan(0.085);
    expect(cubeZ).toBeLessThan(0.13);
    sim.dispose();
  });
});
