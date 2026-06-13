// Constraint body-local frame correctness (the fix in frame.ts wired into every
// backend). A fixed joint must lock a constrained body in its CURRENT pose — even
// when that body has a non-identity orientation. The pre-fix code passed identity
// reference frames (rapier/ammo) and world-space anchors/axes, which only happens
// to be correct when the body's orientation is identity; for a rotated body it
// drove the body back toward identity (fixed) or hinged about the wrong axis.

import { describe, expect, it } from "vitest";

import { PredictionSim, initSim } from "./prediction.js";
import type { BackendName } from "./engine.js";
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

// A fixed ground (identity) + a body rotated 90° about Z, pinned by a FIXED joint
// at the body. A correct fixed joint locks the body's CURRENT pose, so it stays
// rotated; the identity-frame bug drives it back toward identity.
function rotatedFixedManifest(): SimManifest {
  return {
    version: 1,
    source: "test:rotated-fixed",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "block", mass: 1, com: [0.2, 0, 0], orientation: [0, 0, S, S], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "fixed", bodyA: "ground", bodyB: "block", origin: [0.2, 0, 0], axis: [0, 0, 1] }],
  };
}

// A fixed ground + a body rotated 90° about Z, pinned by a HINGE about world +X
// through the origin. A correct (body-local) axis makes it swing in the YZ plane
// (x stays ≈ 0); the pre-fix raw-world axis, mis-read in the rotated body's frame,
// swings it out of that plane.
function rotatedHingeManifest(): SimManifest {
  return {
    version: 1,
    source: "test:rotated-hinge",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "arm", mass: 1, com: [0, 0.2, 0], orientation: [0, 0, S, S], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "hinge", bodyA: "ground", bodyB: "arm", origin: [0, 0, 0], axis: [1, 0, 0] }],
  };
}

// A double pendulum with BOTH links massive: a fixed anchor → arm A (hinge) → arm B
// (hinge off A). B is a non-root dynamic body whose tree's centre of mass is offset
// from its own COM — the case where MuJoCo's `cvel` linear part (referenced to the
// tree-root subtree-COM) differs from the body's own-COM velocity. Used to verify
// the snapshot's per-body linear-velocity reporting in a multi-link chain.
function dynamicChainManifest(): SimManifest {
  return {
    version: 1,
    source: "test:dynamic-chain",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "anchor", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.02)], fixed: true },
      { id: "A", mass: 1, com: [0.2, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
      { id: "B", mass: 1, com: [0.4, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [
      { kind: "hinge", bodyA: "anchor", bodyB: "A", origin: [0, 0, 0], axis: [0, 1, 0] },
      { kind: "hinge", bodyA: "A", bodyB: "B", origin: [0.3, 0, 0], axis: [0, 1, 0] },
    ],
  };
}

const BACKENDS: BackendName[] = ["rapier", "cannon", "ammo", "mujoco"];
// rapier-compat's single-axis `JointData.revolute` can't express a world-axis hinge
// between differently-oriented bodies (see the LIMITATION note in rapier.ts), so the
// rotated-hinge correctness check covers only the backends that get the world-axis
// hinge right: the per-body-axis maximal backends (cannon/ammo) and MuJoCo, whose
// native tree joint expresses it directly. rapier's hinge for identity-oriented
// bodies is covered by prediction.test.ts.
const HINGE_BACKENDS: BackendName[] = ["cannon", "ammo", "mujoco"];

describe.each(BACKENDS)("constraint body-local frame (fixed): %s", (backend) => {
  it("a fixed joint HOLDS a rotated body's orientation (doesn't un-rotate it)", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(120, 1n);
    expect(sim.spawnManifest(JSON.stringify(rotatedFixedManifest()))).toBe(2);
    for (let i = 0; i < 60; i++) sim.stepDynamics();
    const q = sim.bodyOrientation(1); // the rotated block
    // Must still be ≈ 90° about +Z (|z| ≈ |w| ≈ √½). The bug drives it toward
    // identity ([0,0,0,1] → |z|→0, |w|→1), which this catches.
    expect(Math.abs(q[2])).toBeCloseTo(S, 1);
    expect(Math.abs(q[3])).toBeCloseTo(S, 1);
    sim.dispose();
  });
});

describe.each(HINGE_BACKENDS)("constraint body-local frame (hinge): %s", (backend) => {
  it("a hinge on a rotated body swings about the WORLD axis (stays in the hinge plane)", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(120, 1n);
    expect(sim.spawnManifest(JSON.stringify(rotatedHingeManifest()))).toBe(2);
    const startZ = sim.bodyPosition(1)[2];
    // Track the WHOLE swing rather than just the endpoint. +X hinge through the
    // origin → the arm rotates in the YZ plane, so its X stays ≈ 0 at every step (a
    // mis-rotated axis would drift it out of plane). It must also genuinely swing
    // down below the hinge. We assert the minimum Z reached, not the final Z,
    // because an undamped engine (MuJoCo) completes a half-swing within these 60
    // steps and is back near the start height at the end — a final-position check
    // would be phase-dependent, while min-Z and max-|X| are invariant.
    let maxAbsX = 0;
    let minZ = Infinity;
    for (let i = 0; i < 60; i++) {
      sim.stepDynamics();
      const p = sim.bodyPosition(1);
      maxAbsX = Math.max(maxAbsX, Math.abs(p[0]));
      minZ = Math.min(minZ, p[2]);
    }
    expect(maxAbsX).toBeLessThan(0.02); // never leaves the hinge (YZ) plane
    expect(minZ).toBeLessThan(startZ - 0.05); // swung well down below the hinge
    sim.dispose();
  });
});

// MuJoCo-specific: a snapshot must report each body's OWN-COM world linear velocity,
// even in a multi-link dynamic chain. MuJoCo's `cvel` linear part is referenced to the
// tree-root subtree-COM, so for a non-root dynamic body (the leaf of a double pendulum)
// the raw value is offset by ω × (x_com − subtree_com[root]); the backend corrects it.
// This guards that correction — drop it and the reported velocity stops matching a
// finite-difference of the body's own position. (Maximal backends report per-body COM
// velocity natively and need no such correction, so this check is MuJoCo-only.)
describe("mujoco multi-link snapshot velocity (subtree-COM correction)", () => {
  it("reports the leaf body's own-COM linear velocity in a dynamic chain", async () => {
    await initSim({ backend: "mujoco" });
    const RATE = 240;
    const sim = new PredictionSim(RATE, 1n);
    expect(sim.spawnManifest(JSON.stringify(dynamicChainManifest()))).toBe(3);
    for (let i = 0; i < 120; i++) sim.stepDynamics(); // set both links swinging
    const snap = sim.snapshot();
    const v = snap.bodies[2]!.linearVelocity; // leaf body B
    expect(Math.hypot(v[0], v[1], v[2])).toBeGreaterThan(0.1); // genuinely moving
    // Finite-difference B's own COM and compare to the reported velocity.
    const before = sim.bodyPosition(2);
    sim.stepDynamics();
    const after = sim.bodyPosition(2);
    const dt = 1 / RATE;
    expect(v[0]).toBeCloseTo((after[0] - before[0]) / dt, 1); // within 0.05
    expect(v[1]).toBeCloseTo((after[1] - before[1]) / dt, 1);
    expect(v[2]).toBeCloseTo((after[2] - before[2]) / dt, 1);
    sim.dispose();
  });
});
