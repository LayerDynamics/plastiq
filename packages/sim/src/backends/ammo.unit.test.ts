// ammo (Bullet) backend — UNIT tests for its wasm RESOURCE MANAGEMENT. Bullet objects
// are manual emscripten allocations with no GC, so the contract is that every object
// spawn()/pose()/snapshot() allocates is eventually freed via Ammo.destroy(). These
// tests wrap the REAL ammo module so every `new module.btX(...)` is recorded as a live
// allocation and every destroy() clears it, then assert the books balance:
//   • spawn()+dispose() leaves ZERO live allocations — the regression for the leak
//     where dispose() freed only the bodies/world/tmp/childTransform and silently
//     dropped the dispatch stack (config/dispatcher/broadphase/solver), the collision
//     shapes, the motion states, the construction info, and the constraints (Bullet's
//     destructors do not cascade to objects the world/bodies merely reference).
//   • pose()/snapshot() free the btQuaternion that btTransform.getRotation() returns
//     BY VALUE — the regression for the per-frame readout leak.
// (Emergent physics and the cross-backend method contracts live in the backends.* and
// constraint-frame.* suites; this file is ammo-specific memory bookkeeping only.)

import { beforeAll, describe, expect, it } from "vitest";
import Ammo from "ammojs-typed";

import { AmmoEngine } from "./ammo.js";
import type { SimManifest } from "../manifest.js";
import {
  boxHull,
  boxHullXYZ,
  fixedJointManifest,
  freeBodyManifest,
  hingeManifest,
  loopFixedManifest,
} from "./fixtures.js";

type AmmoModule = Awaited<ReturnType<typeof Ammo>>;

// A single body carrying TWO convex-hull colliders → a compound of two hulls. Every
// shared fixture is single-collider, so this is the only case that drives the
// per-piece hull loop (and its per-vertex scratch frees) with N>1 hulls per body.
function multiColliderManifest(): SimManifest {
  return {
    version: 1,
    source: "test:multi-collider",
    gravity: [0, 0, -9.81],
    bodies: [
      {
        id: "b0",
        mass: 1,
        com: [0, 0, 1],
        orientation: [0, 0, 0, 1],
        colliders: [boxHull(0.05), boxHullXYZ(0.03, 0.03, 0.1)],
      },
    ],
    constraints: [],
  };
}

// Every Bullet constructor the engine reaches through `new module.btX(...)`. Wrapping
// each lets the counting module record allocations without changing behaviour: the
// wrapper builds the REAL object and returns it, so its methods and `instanceof` still
// work and only the explicit `new module.btX` allocations flow through the tally.
const CTORS = [
  "btTransform",
  "btVector3",
  "btQuaternion",
  "btDefaultCollisionConfiguration",
  "btCollisionDispatcher",
  "btDbvtBroadphase",
  "btSequentialImpulseConstraintSolver",
  "btDiscreteDynamicsWorld",
  "btCompoundShape",
  "btConvexHullShape",
  "btDefaultMotionState",
  "btRigidBodyConstructionInfo",
  "btRigidBody",
  "btHingeConstraint",
  "btFixedConstraint",
] as const;

interface CountingModule {
  /** A drop-in module: wrapped constructors + destroy, everything else falls through. */
  module: AmmoModule;
  /** Allocations constructed via `new module.btX(...)` but not yet destroyed. */
  live: Set<unknown>;
  /** Tally of freed btQuaternions — the by-value getRotation() readouts land here. */
  counters: { quaternionsFreed: number };
}

// Wrap `real` so construction and destruction are observable. Unwrapped members fall
// through via the prototype chain; the engine only ever touches the CTORS + destroy.
function makeCountingModule(real: AmmoModule): CountingModule {
  const live = new Set<unknown>();
  const counters = { quaternionsFreed: 0 };
  const wrapped = Object.create(real) as AmmoModule;
  const slots = wrapped as unknown as Record<string, unknown>;
  for (const name of CTORS) {
    const RealCtor = real[name] as unknown as new (...args: never[]) => object;
    slots[name] = function (...args: never[]): object {
      const obj = new RealCtor(...args);
      live.add(obj);
      return obj;
    };
  }
  wrapped.destroy = (o: unknown): void => {
    // getRotation() returns a btQuaternion by value; its only correct disposal is a
    // destroy() here, so counting quaternion frees pins the per-frame readout fix.
    if (o instanceof real.btQuaternion) counters.quaternionsFreed++;
    live.delete(o); // a no-op for objects Bullet allocated internally (e.g. getRotation)
    real.destroy(o);
  };
  return { module: wrapped, live, counters };
}

let real: AmmoModule;
beforeAll(async () => {
  // The same strict-mode-safe invocation AmmoBackend.init() uses: the factory's
  // trailing `this.Ammo = b` throws under ESM strict mode unless given a throwaway
  // `this`. (Loaded once — the wasm module is reusable across engines.)
  real = await (Ammo as unknown as (this: object) => Promise<AmmoModule>).call({});
});

describe("AmmoEngine — wasm allocation balance (no per-spawn leak)", () => {
  it.each([
    ["a free body", freeBodyManifest],
    ["a body with two hull colliders", multiColliderManifest],
    ["a hinge constraint", hingeManifest],
    ["a fixed constraint", fixedJointManifest],
    ["a fixed loop (3 bodies, 3 constraints)", loopFixedManifest],
  ])("spawn()+dispose() frees every allocation for %s", (_label, build) => {
    const { module, live } = makeCountingModule(real);
    const engine = new AmmoEngine(module, 1 / 60);
    engine.spawn(build());
    expect(live.size).toBeGreaterThan(0); // sanity: the wrapper really did see allocations
    engine.dispose();
    expect(live.size).toBe(0); // …and dispose() freed all of them
  });

  it("a spawn → step → dispose cycle still frees every allocation", () => {
    const { module, live } = makeCountingModule(real);
    const engine = new AmmoEngine(module, 1 / 60);
    engine.spawn(hingeManifest());
    for (let i = 0; i < 30; i++) engine.step();
    engine.dispose();
    expect(live.size).toBe(0);
  });
});

describe("AmmoEngine — per-frame readout frees getRotation()'s by-value quaternion", () => {
  it("pose() frees exactly one btQuaternion (the transform's getRotation())", () => {
    const { module, counters } = makeCountingModule(real);
    const engine = new AmmoEngine(module, 1 / 60);
    engine.spawn(freeBodyManifest());
    const before = counters.quaternionsFreed;
    engine.pose(0);
    expect(counters.quaternionsFreed - before).toBe(1);
    engine.dispose();
  });

  it("snapshot() frees one btQuaternion per body", () => {
    const { module, counters } = makeCountingModule(real);
    const engine = new AmmoEngine(module, 1 / 60);
    engine.spawn(loopFixedManifest()); // 3 bodies
    const before = counters.quaternionsFreed;
    engine.snapshot();
    expect(counters.quaternionsFreed - before).toBe(3);
    engine.dispose();
  });
});
