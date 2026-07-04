// Shared manifest fixtures for the physics backends' smoke / unit / integration
// suites (the per-backend mujoco.* files and the parameterized backends.* files).
// Not a *.test.ts file, so the vitest glob never runs it as a test — it only exports
// builders the tiers compose. Kept here (not in each test) so the box geometry +
// manifest shapes stay in lock-step across every backend tier.

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

/** Two bodies + a hinge whose bodyB names a body that does not exist. Rejected
 * by parseManifest/isSimManifest; fed straight to a backend's spawn() it must
 * trip the defensive missing-body throw. */
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

/** A four-bar linkage in the XZ plane, all hinge axes +Y: ground → crank
 * (hinge at [0,0,0.6]) → coupler (hinge at [0,0,0.4]) → rocker (hinge at
 * [0.4,0,0.4]) → back to ground (hinge at [0.4,0,0.6] — the LOOP-CLOSING edge).
 * The BFS tree reaches crank+rocker from ground and coupler from crank, so the
 * coupler–rocker hinge closes the kinematic loop. Gravity leans +X so the
 * parallelogram starts OFF its hanging equilibrium and genuinely swings. */
export function fourBarManifest(): SimManifest {
  const Y: [number, number, number] = [0, 1, 0];
  return {
    version: 1,
    source: "test:four-bar",
    gravity: [3, 0, -9.81],
    bodies: [
      { id: "ground", mass: 0, com: [0.2, 0, 0.7], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "crank", mass: 1, com: [0, 0, 0.5], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
      { id: "coupler", mass: 1, com: [0.2, 0, 0.4], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
      { id: "rocker", mass: 1, com: [0.4, 0, 0.5], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [
      { kind: "hinge", bodyA: "ground", bodyB: "crank", origin: [0, 0, 0.6], axis: Y },
      { kind: "hinge", bodyA: "crank", bodyB: "coupler", origin: [0, 0, 0.4], axis: Y },
      { kind: "hinge", bodyA: "coupler", bodyB: "rocker", origin: [0.4, 0, 0.4], axis: Y },
      { kind: "hinge", bodyA: "rocker", bodyB: "ground", origin: [0.4, 0, 0.6], axis: Y },
    ],
  };
}

/** Fixed anchor + a body 0.3 m out on a SLIDER along +X through the origin.
 * Gravity has a +X component (drives the slide AWAY from the anchor — no
 * contact) and a −Z component (must be resisted): the body may only translate
 * along X, never fall or rotate. */
export function sliderManifest(): SimManifest {
  return {
    version: 1,
    source: "test:slider",
    gravity: [2, 0, -9.81],
    bodies: [
      { id: "anchor", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.02)], fixed: true },
      { id: "sled", mass: 1, com: [0.3, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "slider", bodyA: "anchor", bodyB: "sled", origin: [0, 0, 0], axis: [1, 0, 0] }],
  };
}

/** Fixed anchor + a bob 0.2 m out on a BALL joint at the origin: a spherical
 * pendulum — the bob stays a constant 0.2 m from the pivot while swinging down. */
export function ballManifest(): SimManifest {
  return {
    version: 1,
    source: "test:ball",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "anchor", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.02)], fixed: true },
      { id: "bob", mass: 1, com: [0.2, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "ball", bodyA: "anchor", bodyB: "bob", origin: [0, 0, 0], axis: [0, 0, 1] }],
  };
}

/** Fixed anchor + a crank on a CYLINDRICAL joint along the world X axis, with
 * its COM 0.1 m OFF the axis: the −Z gravity torques it around the axis (the
 * rotation DOF), the +X component drives the free slide DOF away from the
 * anchor, and the axis pins the COM to the y²+z² = 0.1² circle. */
export function cylindricalManifest(): SimManifest {
  return {
    version: 1,
    source: "test:cylindrical",
    gravity: [1, 0, -9.81],
    bodies: [
      { id: "anchor", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.02)], fixed: true },
      { id: "crank", mass: 1, com: [0.3, 0.1, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "cylindrical", bodyA: "anchor", bodyB: "crank", origin: [0, 0, 0], axis: [1, 0, 0] }],
  };
}

/** Fixed anchor + a puck on a PLANAR joint (normal +Z, plane z = 0.2). Gravity
 * has in-plane X/Y components (the puck accelerates freely in the plane) and a
 * −Z component that the plane must resist: z stays put, x and y move. */
export function planarManifest(): SimManifest {
  return {
    version: 1,
    source: "test:planar",
    gravity: [1.5, 2.5, -9.81],
    bodies: [
      { id: "anchor", mass: 0, com: [0, 0, 0.2], orientation: [0, 0, 0, 1], colliders: [boxHull(0.02)], fixed: true },
      { id: "puck", mass: 1, com: [0.15, 0, 0.2], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "planar", bodyA: "anchor", bodyB: "puck", origin: [0, 0, 0.2], axis: [0, 0, 1] }],
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

/** Same triangle, but every edge is a HINGE — the loop-closing one lowers to a
 * pair of <connect> point equalities on the hinge axis (MuJoCo). */
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
