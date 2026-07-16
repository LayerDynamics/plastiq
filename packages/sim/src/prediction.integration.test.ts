// R6 — pluggable physics: every backend spawns a manifest and steps under gravity.

import { afterEach, describe, expect, it, vi } from "vitest";

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

/**
 * An L-shaped compound collider built from TWO box pieces (a 0.1×0.05×0.05 foot
 * and a 0.05×0.05×0.05 upright), expressed in a frame centred on the L. This is a
 * genuine multi-piece compound — the shape a concave part decomposes into.
 */
function lCompound(): HullCollider[] {
  // Foot: half (0.05,0.025,0.025) at centre (0,0,-0.025) → vol 2.5e-4.
  // Upright: half (0.025,0.025,0.025) at centre (-0.025,0,0.025) → vol 1.25e-4.
  // Volume-weighted COM = (-1/120, 0, -1/120) ≈ (-0.008333,0,-0.008333). Re-centre
  // both pieces on it so the body origin = COM (the manifest invariant: pieces are
  // COM-local), making readback identical across all backends.
  const sx = 1 / 120;
  const sz = 1 / 120;
  const foot = shiftHull(boxHullXYZ(0.05, 0.025, 0.025), 0 + sx, 0, -0.025 + sz);
  const upright = shiftHull(boxHullXYZ(0.025, 0.025, 0.025), -0.025 + sx, 0, 0.025 + sz);
  return [foot, upright];
}

/** Translate every vertex of a hull collider by (dx,dy,dz). */
function shiftHull(h: HullCollider, dx: number, dy: number, dz: number): HullCollider {
  const points = h.points.slice();
  for (let k = 0; k < points.length; k += 3) {
    points[k]! += dx;
    points[k + 1]! += dy;
    points[k + 2]! += dz;
  }
  return { points, faces: h.faces.map((f) => [...f]) };
}

function restManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      // A fixed 2×2×0.1 m ground slab; its top surface is at z = 0.05.
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHullXYZ(1, 1, 0.05)], fixed: true },
      // A 0.1 m cube dropped from z = 0.5.
      { id: "cube", mass: 1, com: [0, 0, 0.5], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [],
  };
}

/** Drop the L-shaped COMPOUND collider onto the ground (exercises multi-piece). */
function compoundRestManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHullXYZ(1, 1, 0.05)], fixed: true },
      // The L's lowest point (foot bottom) is at local z = -0.05; spawn its COM
      // at z = 0.5 so the foot bottom starts at 0.45 and falls onto the slab top.
      { id: "ell", mass: 1, com: [0, 0, 0.5], orientation: [0, 0, 0, 1], colliders: lCompound() },
    ],
    constraints: [],
  };
}

function dropManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [{ id: "b0", mass: 1, com: [0, 0, 1], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] }],
    constraints: [],
  };
}

function hingeManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 1, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "b", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "hinge", bodyA: "a", bodyB: "b", origin: [0.05, 0, 0], axis: [0, 1, 0] }],
  };
}

/**
 * A pendulum: a small FIXED anchor at the origin and a 0.1 m arm hung 0.3 m out
 * on a hinge through the origin (axis +y). The arm is far enough from the anchor
 * that it never contacts it, so it swings FREELY under gravity — a clean source
 * of sustained angular velocity. (Two ADJACENT jointed cubes, like hingeManifest,
 * collide at the shared face and barely rotate, so they can't exercise replay.)
 */
function pendulumManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "anchor", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.02)], fixed: true },
      { id: "arm", mass: 1, com: [0.3, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "hinge", bodyA: "anchor", bodyB: "arm", origin: [0, 0, 0], axis: [0, 1, 0] }],
  };
}

/** A ground slab + three 0.1 m cubes stacked vertically, dropped to settle. */
function pileManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "ground", mass: 0, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHullXYZ(1, 1, 0.05)], fixed: true },
      { id: "c0", mass: 1, com: [0, 0, 0.12], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
      { id: "c1", mass: 1, com: [0, 0, 0.3], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
      { id: "c2", mass: 1, com: [0, 0, 0.5], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [],
  };
}

/** Two bodies + a hinge whose bodyB names a body that doesn't exist. */
function badConstraintManifest(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 1, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)], fixed: true },
      { id: "b", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [{ kind: "hinge", bodyA: "a", bodyB: "nonexistent", origin: [0.05, 0, 0], axis: [0, 1, 0] }],
  };
}

const BACKENDS: BackendName[] = ["rapier", "cannon", "ammo", "mujoco"];

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("a 2-piece COMPOUND collider falls and rests on the ground (decomposed-part collision works)", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(120, 1n);
    expect(sim.spawnManifest(JSON.stringify(compoundRestManifest()))).toBe(2);

    for (let i = 0; i < 300; i++) sim.stepDynamics();
    const ellZ = sim.bodyPosition(1)[2];

    // The L rests on its foot: foot bottom (local z = -0.05 + 1/120 ≈ -0.04167)
    // sits on the slab top (z = 0.05), so the COM rests at ≈ 0.0917. This only
    // holds if BOTH compound pieces collide and the COM-frame readback is intact —
    // it did not tunnel (would be far negative) or hover (would still be ~0.5).
    expect(ellZ).toBeGreaterThan(0.08);
    expect(ellZ).toBeLessThan(0.125);
    sim.dispose();
  });

  it("settles a multi-body stack on the ground (contact between bodies resolves)", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(120, 1n);
    expect(sim.spawnManifest(JSON.stringify(pileManifest()))).toBe(4);

    for (let i = 0; i < 600; i++) sim.stepDynamics();
    // Bodies 1..3 are the cubes (0 is the fixed ground).
    const zs = [sim.bodyPosition(1)[2], sim.bodyPosition(2)[2], sim.bodyPosition(3)[2]];

    // Every cube came to rest in a band above the ground top: none tunnelled
    // through the slab or each other (z > 0.08) and none stayed aloft / launched
    // (z < 0.45 — they fell from 0.12/0.3/0.5). The pile has real HEIGHT — they did
    // not all collapse onto z≈0.10, which only holds if body-body contact resolves
    // and pushes them apart. (We don't assert strict stacking order: cannon-es's
    // soft convex contacts let the cubes interpenetrate and reshuffle, unlike the
    // firmer Rapier/Bullet stacks.)
    for (const z of zs) {
      expect(z).toBeGreaterThan(0.08);
      expect(z).toBeLessThan(0.45);
    }
    const spread = Math.max(...zs) - Math.min(...zs);
    expect(spread).toBeGreaterThan(0.04); // contact gives the pile height
    expect(spread).toBeLessThan(0.3); // but they piled near the ground, not scattered
    sim.dispose();
  });

  it("REJECTS (does not warn-and-drop) a constraint that references a missing body", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(60, 1n);

    // Dangling refs are a validation failure at parse time — spawnManifest throws
    // before any backend sees the manifest (a dropped joint would silently
    // simulate a different mechanism).
    expect(() => sim.spawnManifest(JSON.stringify(badConstraintManifest()))).toThrow(
      /SimManifest: hinge constraint references missing body 'nonexistent'/,
    );
    sim.dispose();
  });

  it("disposes cleanly and can re-spawn (resource cleanup is sound)", async () => {
    await initSim({ backend });
    const first = new PredictionSim(60, 1n);
    expect(first.spawnManifest(JSON.stringify(restManifest()))).toBe(2);
    for (let i = 0; i < 30; i++) first.stepDynamics();
    first.dispose(); // frees the world (and, for ammo, every body explicitly)

    // Re-initialise the same backend and spawn a fresh world — no crash, no
    // dangling state from the freed engine.
    await initSim({ backend });
    const second = new PredictionSim(60, 1n);
    expect(second.spawnManifest(JSON.stringify(dropManifest()))).toBe(1);
    for (let i = 0; i < 30; i++) second.stepDynamics();
    expect(second.bodyPosition(0)[2]).toBeLessThan(1); // the new world still simulates
    second.dispose();
  });

  it("snapshot + restore rewinds to the exact dynamic state and replays the trajectory", async () => {
    await initSim({ backend });
    const sim = new PredictionSim(60, 1n);
    sim.spawnManifest(JSON.stringify(dropManifest())); // a single free-falling body (no contacts)

    for (let i = 0; i < 30; i++) sim.stepDynamics();
    const snap = sim.snapshot();
    // The body is mid-fall, so it has real downward velocity captured.
    expect(snap.bodies[0]!.linearVelocity[2]).toBeLessThan(-1);

    // Run forward and record where it ends up.
    for (let i = 0; i < 30; i++) sim.stepDynamics();
    const forward = sim.bodyPosition(0);

    // Rewind: restore returns the body to the captured pose...
    sim.restore(snap);
    expect(sim.bodyPosition(0)[2]).toBeCloseTo(snap.bodies[0]!.position[2], 6);

    // ...and re-stepping reproduces the SAME trajectory — only possible because the
    // snapshot captured velocity too (pose-only would fall from rest and diverge).
    for (let i = 0; i < 30; i++) sim.stepDynamics();
    const replay = sim.bodyPosition(0);
    expect(replay[0]).toBeCloseTo(forward[0], 5);
    expect(replay[1]).toBeCloseTo(forward[1], 5);
    expect(replay[2]).toBeCloseTo(forward[2], 5);
    sim.dispose();
  });

  it("snapshot + restore preserves a CONSTRAINED body's swing (hinge) and replays it", async () => {
    await initSim({ backend });
    // Durations are expressed in sim-time (seconds) and converted at the engine's
    // integration rate, so the counts track dt rather than baking in a step number.
    const RATE_HZ = 60;
    const sim = new PredictionSim(RATE_HZ, 1n);
    const stepFor = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds * RATE_HZ); i++) sim.stepDynamics();
    };
    expect(sim.spawnManifest(JSON.stringify(pendulumManifest()))).toBe(2);

    // The arm (body 1) hangs 0.3 m out on a hinge and swings DOWN under gravity.
    // Snapshot a quarter-second in — well into the first swing, carrying real
    // angular velocity.
    const armStartZ = sim.bodyPosition(1)[2];
    stepFor(0.25);
    const snap = sim.snapshot();

    // Mid-swing the arm is actively rotating. 0.1 rad/s is a deliberately loose
    // "is it really turning" gate (a released pendulum reaches several rad/s) with
    // wide margin; the PRECISE checks are the deterministic restore/replay
    // comparisons below. A snapshot that dropped angular velocity could not
    // reproduce the continued swing.
    const w = snap.bodies[1]!.angularVelocity;
    expect(Math.hypot(w[0], w[1], w[2])).toBeGreaterThan(0.1);
    // It genuinely swung well down from its start (the 10 mm floor is far below
    // the ~0.3 m it eventually drops).
    expect(sim.bodyPosition(1)[2]).toBeLessThan(armStartZ - 0.01);

    // Run forward and record where the swinging arm ends up.
    stepFor(0.67);
    const forward = sim.bodyPosition(1);

    // Rewind: the arm returns to the exact captured pose. restore writes the
    // state directly, so this holds to FP precision independent of integrator
    // parameters.
    sim.restore(snap);
    const restored = sim.bodyPosition(1);
    expect(restored[0]).toBeCloseTo(snap.bodies[1]!.position[0], 6);
    expect(restored[1]).toBeCloseTo(snap.bodies[1]!.position[1], 6);
    expect(restored[2]).toBeCloseTo(snap.bodies[1]!.position[2], 6);

    // ...and re-stepping reproduces the same swing. This compares the replay
    // against the forward run on the SAME engine, so it stays valid if integrator
    // params change — it only fails if pose/angular-velocity capture is incomplete.
    stepFor(0.67);
    const replay = sim.bodyPosition(1);
    expect(replay[0]).toBeCloseTo(forward[0], 3);
    expect(replay[1]).toBeCloseTo(forward[1], 3);
    expect(replay[2]).toBeCloseTo(forward[2], 3);

    // The fixed base (body 0) never moved through any of this.
    expect(sim.bodyPosition(0)[2]).toBeCloseTo(0, 6);
    sim.dispose();
  });

  it("snapshot + restore returns EVERY body in a multi-body contact scene to its exact state", async () => {
    await initSim({ backend });
    const RATE_HZ = 120; // finer step keeps the stacking contacts stable
    const sim = new PredictionSim(RATE_HZ, 1n);
    const stepFor = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds * RATE_HZ); i++) sim.stepDynamics();
    };
    expect(sim.spawnManifest(JSON.stringify(pileManifest()))).toBe(4);

    // Let the stack fall and begin settling (bodies in contact, still moving).
    stepFor(1.67);
    const snap = sim.snapshot();
    expect(snap.bodies).toHaveLength(4);

    // Step forward, then rewind: EVERY body (ground + 3 cubes) returns to its
    // exact captured pose. restore writes the state directly, so equality holds
    // to FP precision regardless of integrator behaviour; the free-fall replay
    // test only restores ONE body, so a mishandled i-th body would slip through.
    stepFor(0.83);
    sim.restore(snap);
    for (let b = 0; b < 4; b++) {
      const p = sim.bodyPosition(b);
      expect(p[0]).toBeCloseTo(snap.bodies[b]!.position[0], 6);
      expect(p[1]).toBeCloseTo(snap.bodies[b]!.position[1], 6);
      expect(p[2]).toBeCloseTo(snap.bodies[b]!.position[2], 6);
    }

    // The restored world keeps simulating sanely (no NaN / explosion). The band
    // mirrors the settle test above — above the ground top (z>0.08) and below the
    // drop heights (z<0.45) — wide margins that tolerate integrator changes.
    stepFor(0.83);
    for (let b = 1; b < 4; b++) {
      const z = sim.bodyPosition(b)[2];
      expect(z).toBeGreaterThan(0.08);
      expect(z).toBeLessThan(0.45);
    }
    sim.dispose();
  });
});
