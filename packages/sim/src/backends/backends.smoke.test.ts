// Physics backends — SMOKE tests, parameterized across ALL four backends
// (rapier / ammo / cannon / mujoco). The fast "every method runs at all" sweep on
// each REAL engine (no mocks): init → createEngine → spawn → bodyCount → step →
// pose → snapshot → restore → dispose, checked for no-throw + sane shapes. Depth
// lives in the integration suites (prediction.integration.test.ts, constraint-frame.integration.test.ts,
// mujoco.integration.test.ts); isolated contracts live in backends.unit.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { RapierBackend } from "./rapier.js";
import { AmmoBackend } from "./ammo.js";
import { CannonBackend } from "./cannon.js";
import { MujocoBackend } from "./mujoco.js";
import type { BackendName, PhysicsBackend } from "../engine.js";
import { freeBodyManifest } from "./fixtures.js";

const REGISTRY: Record<BackendName, () => PhysicsBackend> = {
  rapier: () => new RapierBackend(),
  ammo: () => new AmmoBackend(),
  cannon: () => new CannonBackend(),
  mujoco: () => new MujocoBackend(),
};
const NAMES: BackendName[] = ["rapier", "ammo", "cannon", "mujoco"];

const allFinite = (v: readonly number[]): boolean => v.every((x) => Number.isFinite(x));

describe.each(NAMES)("backend smoke: %s", (name) => {
  let backend: PhysicsBackend;
  beforeAll(async () => {
    backend = REGISTRY[name]();
    await backend.init();
  });

  it("name + init + createEngine expose a working engine", () => {
    expect(backend.name).toBe(name);
    const engine = backend.createEngine(1 / 60);
    expect(typeof engine.spawn).toBe("function");
    engine.dispose();
  });

  it("spawn → bodyCount → step → pose → snapshot → restore → dispose all run cleanly", () => {
    const engine = backend.createEngine(1 / 60);

    expect(engine.spawn(freeBodyManifest())).toBe(1);
    expect(engine.bodyCount).toBe(1);

    expect(() => engine.step()).not.toThrow();

    const pose = engine.pose(0);
    expect(allFinite(pose.position)).toBe(true);
    expect(allFinite(pose.orientation)).toBe(true);

    const snap = engine.snapshot();
    expect(snap.bodies).toHaveLength(1);
    expect(allFinite(snap.bodies[0]!.position)).toBe(true);
    expect(allFinite(snap.bodies[0]!.linearVelocity)).toBe(true);
    expect(allFinite(snap.bodies[0]!.angularVelocity)).toBe(true);

    expect(() => engine.restore(snap)).not.toThrow();
    expect(() => engine.dispose()).not.toThrow();
  });
});
