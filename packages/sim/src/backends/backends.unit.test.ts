// Physics backends — UNIT tests, parameterized across ALL four backends. The
// per-method CONTRACTS in isolation (not emergent physics): bodyCount bookkeeping,
// the pose / restore guard rails, idempotent dispose, and the defensive throw for a
// constraint naming a missing body (parseManifest rejects those upstream; a raw
// spawn() must still fail loudly, never warn-and-drop). These hold identically for
// every backend, so they run once per backend off one table. (Backend-SPECIFIC unit
// logic — MuJoCo's MJCF mapping, its WeakMap restore — lives in mujoco.unit.test.ts.)

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RapierBackend } from "./rapier.js";
import { AmmoBackend } from "./ammo.js";
import { CannonBackend } from "./cannon.js";
import { MujocoBackend } from "./mujoco.js";
import type { BackendName, BodyState, PhysicsBackend, PhysicsSnapshot } from "../engine.js";
import { freeBodyManifest, missingBodyManifest } from "./fixtures.js";

const REGISTRY: Record<BackendName, () => PhysicsBackend> = {
  rapier: () => new RapierBackend(),
  ammo: () => new AmmoBackend(),
  cannon: () => new CannonBackend(),
  mujoco: () => new MujocoBackend(),
};
const NAMES: BackendName[] = ["rapier", "ammo", "cannon", "mujoco"];

const zeroBody = (): BodyState => ({
  position: [0, 0, 0],
  orientation: [0, 0, 0, 1],
  linearVelocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
});

describe.each(NAMES)("backend unit contracts: %s", (name) => {
  let backend: PhysicsBackend;
  beforeAll(async () => {
    backend = REGISTRY[name]();
    await backend.init();
  });
  afterEach(() => vi.restoreAllMocks());

  it("bodyCount is 0 before spawn, the count after, and 0 after dispose", () => {
    const e = backend.createEngine(1 / 60);
    expect(e.bodyCount).toBe(0);
    expect(e.spawn(freeBodyManifest())).toBe(1);
    expect(e.bodyCount).toBe(1);
    e.dispose();
    expect(e.bodyCount).toBe(0);
  });

  it("pose() throws for an out-of-range body index", () => {
    const e = backend.createEngine(1 / 60);
    e.spawn(freeBodyManifest()); // index 0 only
    expect(() => e.pose(1)).toThrow();
    expect(() => e.pose(-1)).toThrow();
    e.dispose();
  });

  it("restore() throws when the snapshot body count differs from the world", () => {
    const e = backend.createEngine(1 / 60);
    e.spawn(freeBodyManifest()); // 1 body
    const twoBody: PhysicsSnapshot = { bodies: [zeroBody(), zeroBody()] };
    expect(() => e.restore(twoBody)).toThrow(/2 bodies/);
    e.dispose();
  });

  it("dispose() is idempotent — a second call does not throw or double-free", () => {
    const e = backend.createEngine(1 / 60);
    e.spawn(freeBodyManifest());
    e.dispose();
    expect(() => e.dispose()).not.toThrow();
  });

  it("spawn() THROWS (defensively) for a constraint naming a missing body — never warn-and-drop", () => {
    // parseManifest/isSimManifest reject dangling refs before spawn; feeding one
    // straight to the backend must still fail loudly with a precise message
    // (the backend names itself and the missing body).
    const e = backend.createEngine(1 / 60);
    expect(() => e.spawn(missingBodyManifest())).toThrow(
      new RegExp(`^${name}: hinge constraint references missing body 'nonexistent'`),
    );
    e.dispose();
  });
});
