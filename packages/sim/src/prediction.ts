// initSim + PredictionSim — the app-facing API. initSim loads a physics backend
// (default Rapier) once; PredictionSim spawns a manifest into it and steps under
// gravity, reporting each body's world COM pose.

import type { BackendName, PhysicsBackend, PhysicsEngine, PhysicsSnapshot } from "./engine.js";
import { parseManifest } from "./manifest.js";

// Each backend is loaded with a dynamic import so the bundler code-splits the
// physics engines (Rapier/ammo/cannon/MuJoCo, each with its own wasm/runtime) into
// separate chunks — only the one the user actually simulates with is fetched,
// instead of all of them bundling eagerly into the app's main chunk.
const REGISTRY: Record<BackendName, () => Promise<PhysicsBackend>> = {
  rapier: async () => new (await import("./backends/rapier.js")).RapierBackend(),
  ammo: async () => new (await import("./backends/ammo.js")).AmmoBackend(),
  cannon: async () => new (await import("./backends/cannon.js")).CannonBackend(),
  mujoco: async () => new (await import("./backends/mujoco.js")).MujocoBackend(),
};

let active: PhysicsBackend | null = null;

/** Load a physics backend (default Rapier). Await before constructing a PredictionSim. */
export async function initSim(opts?: { backend?: BackendName }): Promise<void> {
  const name = opts?.backend ?? "rapier";
  const backend = await REGISTRY[name]();
  await backend.init();
  active = backend;
}

/** Which backend is currently active, or null if initSim hasn't run. */
export function activeBackend(): BackendName | null {
  return active?.name ?? null;
}

export class PredictionSim {
  private readonly engine: PhysicsEngine;

  /**
   * @param tickRateHz fixed simulation rate (the timestep is 1/tickRateHz)
   * @param _seed      determinism seed (accepted for API parity; the deterministic
   *                   backends need none)
   */
  constructor(tickRateHz: number, _seed: bigint) {
    if (!active) throw new Error("PredictionSim: call (and await) initSim() before constructing");
    this.engine = active.createEngine(1 / tickRateHz);
  }

  /** Spawn a SimManifest (JSON). Returns the body count. */
  spawnManifest(json: string): number {
    return this.engine.spawn(parseManifest(json));
  }

  /** Advance one fixed tick under gravity. */
  stepDynamics(): void {
    this.engine.step();
  }

  get bodyCount(): number {
    return this.engine.bodyCount;
  }

  /** World COM position of body `i`. */
  bodyPosition(i: number): [number, number, number] {
    return this.engine.pose(i).position;
  }

  /** World orientation (x,y,z,w) of body `i`. */
  bodyOrientation(i: number): [number, number, number, number] {
    return this.engine.pose(i).orientation;
  }

  /** Capture the full dynamic state (pose + velocities) of every body, so the
   * world can be rewound to this point with {@link restore} — deterministic
   * save / rewind / replay. */
  snapshot(): PhysicsSnapshot {
    return this.engine.snapshot();
  }

  /** Restore every body to a previously captured {@link snapshot}. */
  restore(snapshot: PhysicsSnapshot): void {
    this.engine.restore(snapshot);
  }

  /** Release backend resources. */
  dispose(): void {
    this.engine.dispose();
  }
}
