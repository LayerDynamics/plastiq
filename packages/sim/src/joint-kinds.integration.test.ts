// Full simulated-joint vocabulary — per-kind, per-backend BEHAVIOUR (in the style
// of constraint-frame.integration.test.ts): each new constraint kind must move the
// body with exactly its DOF pattern on every backend that implements it, and every
// unimplemented kind×backend cell must fail LOUDLY at spawn (see the support
// matrix in engine.ts — implemented-or-loud, never silent):
//   slider      — translates along the axis only (no fall, no rotation)
//   ball        — swings about the pivot point at constant radius (no translation)
//   cylindrical — BOTH rotates about and translates along the axis
//   planar      — translates freely in the plane, never along the normal
// cannon-es has no primitive for slider/cylindrical/planar → those spawns THROW;
// rapier cannot frame a slider/cylindrical/planar between differently-oriented
// bodies → those spawns THROW.

import { describe, expect, it } from "vitest";

import { PredictionSim, initSim } from "./prediction.js";
import type { BackendName } from "./engine.js";
import type { SimManifest } from "./manifest.js";
import {
  S,
  ballManifest,
  boxHull,
  cylindricalManifest,
  planarManifest,
  sliderManifest,
} from "./backends/fixtures.js";

const RATE = 240;
const STEPS = 120; // 0.5 s

/** Spawn `manifest` on `backend` and step 0.5 s, recording body-1 poses. */
async function runKind(
  backend: BackendName,
  manifest: SimManifest,
): Promise<{ sim: PredictionSim; track: { p: [number, number, number]; q: [number, number, number, number] }[] }> {
  await initSim({ backend });
  const sim = new PredictionSim(RATE, 1n);
  expect(sim.spawnManifest(JSON.stringify(manifest))).toBe(manifest.bodies.length);
  const track: { p: [number, number, number]; q: [number, number, number, number] }[] = [];
  for (let i = 0; i < STEPS; i++) {
    sim.stepDynamics();
    track.push({ p: sim.bodyPosition(1), q: sim.bodyOrientation(1) });
  }
  return { sim, track };
}

// The backends that implement each kind (cannon throws for the other three —
// asserted separately below).
const SLIDER_BACKENDS: BackendName[] = ["rapier", "ammo", "mujoco"];
const BALL_BACKENDS: BackendName[] = ["rapier", "cannon", "ammo", "mujoco"];
const CYLINDRICAL_BACKENDS: BackendName[] = ["rapier", "ammo", "mujoco"];
const PLANAR_BACKENDS: BackendName[] = ["rapier", "ammo", "mujoco"];

describe.each(SLIDER_BACKENDS)("slider joint behaviour: %s", (backend) => {
  it("translates along the axis only — no fall, no lateral drift, no rotation", async () => {
    const { sim, track } = await runKind(backend, sliderManifest());
    const last = track[track.length - 1]!;
    // The +X gravity component drove it down the rail (½·2·0.5² ≈ 0.25 m)…
    expect(last.p[0]).toBeGreaterThan(0.3 + 0.1);
    for (const { p, q } of track) {
      expect(Math.abs(p[1])).toBeLessThan(0.01); // never left the rail laterally
      expect(Math.abs(p[2])).toBeLessThan(0.01); // never fell (−Z gravity resisted)
      expect(Math.abs(q[3])).toBeGreaterThan(0.999); // never rotated (identity quat)
    }
    sim.dispose();
  });
});

describe.each(BALL_BACKENDS)("ball joint behaviour: %s", (backend) => {
  it("swings about the pivot at constant radius (rotates freely, never translates off it)", async () => {
    const { sim, track } = await runKind(backend, ballManifest());
    let minZ = Infinity;
    for (const { p } of track) {
      // The bob's COM stays on the 0.2 m sphere about the pivot at the origin…
      expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(0.2, 1.5);
      minZ = Math.min(minZ, p[2]);
    }
    expect(minZ).toBeLessThan(-0.08); // …while genuinely swinging down under gravity
    sim.dispose();
  });
});

describe.each(CYLINDRICAL_BACKENDS)("cylindrical joint behaviour: %s", (backend) => {
  it("BOTH rotates about and translates along the axis, pinned to the axis radius", async () => {
    const { sim, track } = await runKind(backend, cylindricalManifest());
    const last = track[track.length - 1]!;
    let minZ = Infinity;
    for (const { p } of track) {
      // COM pinned to the r = 0.1 circle about the X axis (y² + z² invariant)…
      expect(Math.hypot(p[1], p[2])).toBeCloseTo(0.1, 1.5);
      minZ = Math.min(minZ, p[2]);
    }
    expect(minZ).toBeLessThan(-0.03); // …the rotation DOF swung it below the axis…
    expect(last.p[0]).toBeGreaterThan(0.3 + 0.05); // …and the slide DOF carried it along +X
    sim.dispose();
  });
});

describe.each(PLANAR_BACKENDS)("planar joint behaviour: %s", (backend) => {
  it("translates freely in the plane, never along the normal, without tilting", async () => {
    const { sim, track } = await runKind(backend, planarManifest());
    const last = track[track.length - 1]!;
    // The in-plane gravity components accelerated it in X and Y…
    expect(last.p[0]).toBeGreaterThan(0.15 + 0.05);
    expect(last.p[1]).toBeGreaterThan(0.05);
    for (const { p, q } of track) {
      expect(Math.abs(p[2] - 0.2)).toBeLessThan(0.01); // never left the z = 0.2 plane
      expect(Math.abs(q[3])).toBeGreaterThan(0.99); // tilt locked (no torque spins it)
    }
    sim.dispose();
  });
});

// ——— The LOUD unsupported cells (implemented-or-loud, never silent) ———

describe("cannon: unsupported kinds fail loudly at spawn", () => {
  it.each([
    ["slider", sliderManifest],
    ["cylindrical", cylindricalManifest],
    ["planar", planarManifest],
  ])("spawn() throws a precise unsupported-kind error for %s", async (kind, build) => {
    await initSim({ backend: "cannon" });
    const sim = new PredictionSim(RATE, 1n);
    expect(() => sim.spawnManifest(JSON.stringify(build()))).toThrow(
      new RegExp(`cannon: .* does not support ${kind} constraints`),
    );
    sim.dispose();
  });
});

describe("rapier: axis-framed kinds between differently-oriented bodies fail loudly", () => {
  // The sled/crank/puck rotated 90° so its local view of the joint axis no longer
  // matches the anchor's — which rapier's single-frame JointData cannot express
  // for slider/cylindrical/planar (hinge + ball are composed instead and are
  // covered by constraint-frame.integration.test.ts and the suites above).
  // slider/cylindrical (axis +X) rotate about Z; planar (normal +Z) must rotate
  // about X — a rotation about its own normal is the joint's FREE spin DOF and
  // stays expressible (asserted separately below).
  const rotate = (m: SimManifest, q: [number, number, number, number]): SimManifest => {
    m.bodies[1]!.orientation = q;
    return m;
  };
  const ROT_Z90: [number, number, number, number] = [0, 0, S, S];
  const ROT_X90: [number, number, number, number] = [S, 0, 0, S];

  it.each([
    ["slider", (): SimManifest => rotate(sliderManifest(), ROT_Z90)],
    ["cylindrical", (): SimManifest => rotate(cylindricalManifest(), ROT_Z90)],
    ["planar", (): SimManifest => rotate(planarManifest(), ROT_X90)],
  ])("spawn() throws for a rotated-body %s", async (kind, build) => {
    await initSim({ backend: "rapier" });
    const sim = new PredictionSim(RATE, 1n);
    expect(() => sim.spawnManifest(JSON.stringify(build()))).toThrow(
      new RegExp(`rapier: cannot express a ${kind}`),
    );
    sim.dispose();
  });

  it("a planar body rotated about its own NORMAL still spawns (that spin is the free DOF)", async () => {
    await initSim({ backend: "rapier" });
    const sim = new PredictionSim(RATE, 1n);
    // Rotation about +Z = the plane normal: both bodies still read the same local
    // normal, so the generic joint is exact — no throw, and the plane still holds.
    const m = rotate(planarManifest(), ROT_Z90);
    expect(sim.spawnManifest(JSON.stringify(m))).toBe(2);
    for (let i = 0; i < STEPS; i++) sim.stepDynamics();
    expect(Math.abs(sim.bodyPosition(1)[2] - 0.2)).toBeLessThan(0.01); // never left the plane
    sim.dispose();
  });

  it("a rotated-body BALL joint still spawns and behaves (no frames needed)", async () => {
    await initSim({ backend: "rapier" });
    const sim = new PredictionSim(RATE, 1n);
    const m = ballManifest();
    m.bodies[1]!.orientation = [0, 0, S, S];
    expect(sim.spawnManifest(JSON.stringify(m))).toBe(2);
    for (let i = 0; i < STEPS; i++) {
      sim.stepDynamics();
      const p = sim.bodyPosition(1);
      expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(0.2, 1.5); // still pinned to the pivot
    }
    sim.dispose();
  });
});

// A slider between two identically-ROTATED bodies is still expressible on rapier
// (the joint frame is shared, so equal orientations cancel): both bodies at 90°
// about Z, axis world +X — must spawn and slide, not throw.
describe("rapier: slider between EQUALLY-rotated bodies still works", () => {
  it("spawns and slides along the world axis", async () => {
    await initSim({ backend: "rapier" });
    const sim = new PredictionSim(RATE, 1n);
    const m: SimManifest = {
      version: 1,
      source: "test:slider-equal-rot",
      gravity: [2, 0, -9.81],
      bodies: [
        { id: "anchor", mass: 0, com: [0, 0, 0], orientation: [0, 0, S, S], colliders: [boxHull(0.02)], fixed: true },
        { id: "sled", mass: 1, com: [0.3, 0, 0], orientation: [0, 0, S, S], colliders: [boxHull(0.05)] },
      ],
      constraints: [{ kind: "slider", bodyA: "anchor", bodyB: "sled", origin: [0, 0, 0], axis: [1, 0, 0] }],
    };
    expect(sim.spawnManifest(JSON.stringify(m))).toBe(2);
    for (let i = 0; i < STEPS; i++) sim.stepDynamics();
    const p = sim.bodyPosition(1);
    expect(p[0]).toBeGreaterThan(0.3 + 0.1); // slid along world +X
    expect(Math.abs(p[2])).toBeLessThan(0.01); // never fell
    sim.dispose();
  });
});
