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

const BACKENDS: BackendName[] = ["rapier", "cannon", "ammo"];
// rapier-compat's single-axis `JointData.revolute` can't express a world-axis hinge
// between differently-oriented bodies (see the LIMITATION note in rapier.ts), so the
// rotated-hinge correctness check covers only the per-body-axis backends. rapier's
// hinge for identity-oriented bodies is covered by prediction.test.ts.
const HINGE_BACKENDS: BackendName[] = ["cannon", "ammo"];

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
    const p0 = sim.bodyPosition(1);
    for (let i = 0; i < 60; i++) sim.stepDynamics();
    const p1 = sim.bodyPosition(1);
    // +X hinge through the origin → the arm rotates in the YZ plane, so its X stays
    // ≈ 0. A mis-rotated axis swings it out of plane (x drifts). It must also have
    // fallen (z dropped below the hinge).
    expect(Math.abs(p1[0])).toBeLessThan(0.02);
    expect(p1[2]).toBeLessThan(p0[2] - 0.01);
    sim.dispose();
  });
});
