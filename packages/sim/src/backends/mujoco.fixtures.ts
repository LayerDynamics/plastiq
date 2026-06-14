// Shared manifest fixtures for the MuJoCo backend's smoke / unit / integration
// suites. Not a *.test.ts file, so the vitest glob never runs it as a test — it only
// exports builders the three tiers compose. Kept here (not in each test) so the box
// geometry + manifest shapes stay in lock-step across the three files.

import type { HullCollider, SimManifest } from "../manifest.js";

/** 90° about an axis is the quaternion component √½. */
export const S = Math.SQRT1_2;

/** An axis-aligned box hull of half-extents (hx,hy,hz), COM-centred. */
export function boxHullXYZ(hx: number, hy: number, hz: number): HullCollider {
  return {
    points: [
      -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz, // 0..3 bottom
      -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz, //       4..7 top
    ],
    faces: [
      [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
      [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
    ],
  };
}
export const boxHull = (h: number): HullCollider => boxHullXYZ(h, h, h);

/** A single free body 1 m up — the canonical free-fall case. */
export function freeBodyManifest(): SimManifest {
  return {
    version: 1,
    source: "test:free",
    gravity: [0, 0, -9.81],
    bodies: [{ id: "b0", mass: 1, com: [0, 0, 1], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] }],
    constraints: [],
  };
}

/** A free body rotated 90° about +Z (for quaternion-ordering assertions). */
export function rotatedFreeManifest(): SimManifest {
  return {
    version: 1,
    source: "test:rotated-free",
    gravity: [0, 0, 0],
    bodies: [{ id: "b0", mass: 1, com: [0, 0, 0], orientation: [0, 0, S, S], colliders: [boxHull(0.05)] }],
    constraints: [],
  };
}

/** Fixed anchor + an arm hung 0.3 m out on a hinge about +Y through the origin. */
export function hingeManifest(): SimManifest {
  return {
    version: 1,
    source: "test:hinge",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "anchor", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.02)], fixed: true },
      { id: "arm", mass: 1, com: [0.3, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "hinge", bodyA: "anchor", bodyB: "arm", origin: [0, 0, 0], axis: [0, 1, 0] }],
  };
}

/** Fixed ground + a 90°-Z-rotated block pinned by a FIXED joint (holds its pose). */
export function fixedJointManifest(): SimManifest {
  return {
    version: 1,
    source: "test:fixed",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "block", mass: 1, com: [0.2, 0, 0], orientation: [0, 0, S, S], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "fixed", bodyA: "ground", bodyB: "block", origin: [0.2, 0, 0], axis: [0, 0, 1] }],
  };
}

/** A fixed 2×2×0.1 m ground slab + a 0.1 m cube dropped onto it (contact). */
export function restManifest(): SimManifest {
  return {
    version: 1,
    source: "test:rest",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHullXYZ(1, 1, 0.05)], fixed: true },
      { id: "cube", mass: 1, com: [0, 0, 0.5], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [],
  };
}

/** Two bodies + a hinge whose bodyB names a body that does not exist. */
export function missingBodyManifest(): SimManifest {
  return {
    version: 1,
    source: "test:missing",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 1, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "b", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "hinge", bodyA: "a", bodyB: "nonexistent", origin: [0.05, 0, 0], axis: [0, 1, 0] }],
  };
}

/** Three bodies in a triangle of FIXED constraints — the third edge closes a loop
 * (→ a <weld> equality). */
export function loopFixedManifest(): SimManifest {
  return {
    version: 1,
    source: "test:loop-fixed",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "b", mass: 1, com: [0.2, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
      { id: "c", mass: 1, com: [0.2, 0.2, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [
      { kind: "fixed", bodyA: "a", bodyB: "b", origin: [0.1, 0, 0], axis: [0, 0, 1] },
      { kind: "fixed", bodyA: "b", bodyB: "c", origin: [0.2, 0.1, 0], axis: [0, 0, 1] },
      { kind: "fixed", bodyA: "c", bodyB: "a", origin: [0.1, 0.1, 0], axis: [0, 0, 1] },
    ],
  };
}

/** Same triangle, but the loop-closing edge is a HINGE — which MuJoCo has no
 * equality for, so it is dropped with a warning. */
export function loopHingeManifest(): SimManifest {
  return {
    version: 1,
    source: "test:loop-hinge",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "b", mass: 1, com: [0.2, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
      { id: "c", mass: 1, com: [0.2, 0.2, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [
      { kind: "hinge", bodyA: "a", bodyB: "b", origin: [0.1, 0, 0], axis: [0, 1, 0] },
      { kind: "hinge", bodyA: "b", bodyB: "c", origin: [0.2, 0.1, 0], axis: [0, 1, 0] },
      { kind: "hinge", bodyA: "c", bodyB: "a", origin: [0.1, 0.1, 0], axis: [0, 1, 0] },
    ],
  };
}
