// initSim + PredictionSim — the app-facing API. initSim loads a physics backend
// (default Rapier) once; PredictionSim spawns a manifest into it and steps under
// gravity, reporting each body's world COM pose.

import type { BackendName, PhysicsBackend, PhysicsEngine } from "./engine.js";
import { parseManifest } from "./manifest.js";
import { RapierBackend } from "./backends/rapier.js";

const REGISTRY: Record<BackendName, () => PhysicsBackend> = {
  rapier: () => new RapierBackend(),
  ammo: () => new AmmoBackend(),
  cannon: () => new CannonBackend(),
};

let active: PhysicsBackend | null = null;

/** Load a physics backend (default Rapier). Await before constructing a PredictionSim. */
export async function initSim(opts?: { backend?: BackendName }): Promise<void> {
  const name = opts?.backend ?? "rapier";
  const backend = REGISTRY[name]();
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

  /** Release backend resources. */
  dispose(): void {
    this.engine.dispose();
  }
}

// Backends implemented in this package; imported lazily by the registry.
import { AmmoBackend } from "./backends/ammo.js";
import { CannonBackend } from "./backends/cannon.js";
