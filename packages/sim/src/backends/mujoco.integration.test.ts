// MuJoCo backend — INTEGRATION tests. The methods working TOGETHER through the real
// vendored wasm: buildMjcf → spawn → step → pose/snapshot → restore → dispose, plus
// the frame.ts helpers feeding the kinematic-tree mapping. Unlike the unit suite
// (isolated contracts, string assertions) these assert emergent PHYSICS and
// cross-method consistency end-to-end. The shared prediction/constraint-frame suites
// run this backend alongside the others; this file is the MuJoCo-focused pipeline.

import { beforeAll, describe, expect, it } from "vitest";

import { MujocoBackend } from "./mujoco.js";
import type { PhysicsEngine } from "../engine.js";
import {
  S,
  fixedJointManifest,
  freeBodyManifest,
  hingeManifest,
  restManifest,
} from "./fixtures.js";
import type { SimManifest } from "../manifest.js";

let backend: MujocoBackend;

beforeAll(async () => {
  backend = new MujocoBackend();
  await backend.init();
});

/** Spawn a manifest into a fresh engine and advance `steps` fixed ticks. */
function run(manifest: SimManifest, rateHz: number, steps: number): PhysicsEngine {
  const engine = backend.createEngine(1 / rateHz);
  engine.spawn(manifest);
  for (let i = 0; i < steps; i++) engine.step();
  return engine;
}

describe("mujoco backend — integration", () => {
  it("spawn + step + pose: a free body accelerates downward under gravity", () => {
    const e = run(freeBodyManifest(), 60, 60); // 1 s of fall from z = 1
    const z = e.pose(0).position[2];
    expect(z).toBeLessThan(0); // fell well past the start (~½·g·1² ≈ 4.9 m)
    e.dispose();
  });

  it("buildMjcf hinge mapping + step + pose: the arm swings below its hinge, the anchor holds", () => {
    const e = run(hingeManifest(), 60, 30); // 0.5 s swing
    expect(e.pose(1).position[2]).toBeLessThan(-0.01); // arm swung down past the hinge
    expect(e.pose(0).position[2]).toBeCloseTo(0, 6); // fixed anchor never moved
    e.dispose();
  });

  it("mesh geometry + contact: a hull body falls and RESTS on the fixed ground", () => {
    const e = run(restManifest(), 120, 300); // ~2.5 s to settle
    const z = e.pose(1).position[2];
    expect(z).toBeGreaterThan(0.085); // did not tunnel through the slab
    expect(z).toBeLessThan(0.13); // did not hover — it rests on top (~0.10)
    e.dispose();
  });

  it("fixed-weld mapping holds a rotated body's orientation (doesn't un-rotate it)", () => {
    const e = run(fixedJointManifest(), 120, 60);
    const q = e.pose(1).orientation; // still ≈ 90° about +Z
    expect(Math.abs(q[2])).toBeCloseTo(S, 1);
    expect(Math.abs(q[3])).toBeCloseTo(S, 1);
    e.dispose();
  });

  it("snapshot captures real velocity mid-fall", () => {
    const e = run(freeBodyManifest(), 60, 30); // 0.5 s → moving fast
    const snap = e.snapshot();
    expect(snap.bodies[0]!.linearVelocity[2]).toBeLessThan(-1); // genuine downward velocity
    e.dispose();
  });

  it("snapshot → step → restore → step reproduces the exact trajectory", () => {
    const e = backend.createEngine(1 / 60);
    e.spawn(freeBodyManifest());
    for (let i = 0; i < 30; i++) e.step();

    const snap = e.snapshot();
    const atSnap = e.pose(0).position[2];

    for (let i = 0; i < 30; i++) e.step();
    const forward = e.pose(0).position[2];

    e.restore(snap); // exact rewind to the captured reduced state
    expect(e.pose(0).position[2]).toBeCloseTo(atSnap, 9);

    for (let i = 0; i < 30; i++) e.step();
    expect(e.pose(0).position[2]).toBeCloseTo(forward, 9); // replay matches the first run
    e.dispose();
  });

  it("lifecycle: dispose then re-spawn on a fresh engine simulates cleanly", () => {
    const first = run(freeBodyManifest(), 60, 30);
    first.dispose();

    const second = backend.createEngine(1 / 60);
    expect(second.spawn(freeBodyManifest())).toBe(1);
    for (let i = 0; i < 30; i++) second.step();
    expect(second.pose(0).position[2]).toBeLessThan(1); // the fresh world still simulates
    second.dispose();
  });
});
