// MuJoCo backend — SMOKE tests. The fast "does every method run at all" sweep: each
// public method is invoked once on the real vendored wasm and checked for no-throw +
// a sane return shape. Not behavioural depth (that's the integration suite) and not
// edge cases (that's the unit suite) — just a quick health check of the whole surface.

import { describe, expect, it } from "vitest";

import { MujocoBackend, buildMjcf } from "./mujoco.js";
import { freeBodyManifest } from "./fixtures.js";

const isFiniteVec = (v: readonly number[], n: number): boolean =>
  v.length === n && v.every((x) => Number.isFinite(x));

describe("mujoco backend — smoke", () => {
  it("buildMjcf() returns a non-empty MJCF document", () => {
    const xml = buildMjcf(freeBodyManifest(), 1 / 60);
    expect(typeof xml).toBe("string");
    expect(xml).toContain("<mujoco");
    expect(xml).toContain("</mujoco>");
  });

  it("init() + createEngine() + name expose a usable engine", async () => {
    const backend = new MujocoBackend();
    expect(backend.name).toBe("mujoco");
    await expect(backend.init()).resolves.toBeUndefined();
    const engine = backend.createEngine(1 / 60);
    expect(typeof engine.spawn).toBe("function");
    expect(typeof engine.step).toBe("function");
    expect(typeof engine.pose).toBe("function");
    expect(typeof engine.snapshot).toBe("function");
    expect(typeof engine.restore).toBe("function");
    expect(typeof engine.dispose).toBe("function");
    engine.dispose();
  });

  it("spawn → bodyCount → step → pose → snapshot → restore → dispose all run cleanly", async () => {
    const backend = new MujocoBackend();
    await backend.init();
    const engine = backend.createEngine(1 / 60);

    const count = engine.spawn(freeBodyManifest());
    expect(count).toBe(1);
    expect(engine.bodyCount).toBe(1);

    expect(() => engine.step()).not.toThrow();

    const pose = engine.pose(0);
    expect(isFiniteVec(pose.position, 3)).toBe(true);
    expect(isFiniteVec(pose.orientation, 4)).toBe(true);

    const snap = engine.snapshot();
    expect(snap.bodies).toHaveLength(1);
    expect(isFiniteVec(snap.bodies[0]!.position, 3)).toBe(true);
    expect(isFiniteVec(snap.bodies[0]!.linearVelocity, 3)).toBe(true);
    expect(isFiniteVec(snap.bodies[0]!.angularVelocity, 3)).toBe(true);

    expect(() => engine.restore(snap)).not.toThrow();
    expect(() => engine.dispose()).not.toThrow();
  });
});
