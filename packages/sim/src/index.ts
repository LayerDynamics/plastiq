// MechX client-prediction simulation: a typed wrapper over the wasm-compiled
// `mechx-sim-wasm`. It runs the exact same deterministic Rust simulation the
// authoritative server runs, so local prediction matches the server bit-for-bit
// and reconciliation is a clean rewind + replay.

import init, { WasmSim } from "./pkg/mechx_sim.js";
import type { InitInput } from "./pkg/mechx_sim.js";

let initPromise: Promise<void> | null = null;

/**
 * Initialize the wasm module. Call once before constructing a {@link PredictionSim}.
 * Pass the `.wasm` bytes (Node) or a URL/Response (browser); omit to use the
 * default fetch path in a bundler/browser context.
 *
 * Idempotent and concurrency-safe: the in-flight promise is memoized, so
 * overlapping first calls share one initialization instead of racing two. A
 * failed init clears the memo so a later call can retry.
 */
export function initSim(input?: InitInput): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await (input === undefined ? init() : init({ module_or_path: input }));
    })().catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/** A single buffered input sample for one entity handle. */
export interface InputSample {
  readonly handle: number;
  readonly forward: number;
  readonly strafe: number;
  readonly turn: number;
}

/**
 * A predictable simulation instance. Mirrors the authoritative server's sim and
 * supports rewind/replay reconciliation against authoritative snapshots.
 */
export class PredictionSim {
  private readonly sim: WasmSim;

  constructor(tickRateHz: number, seed: bigint) {
    this.sim = new WasmSim(tickRateHz, seed);
  }

  /** Spawn the test entity, returning its input handle. */
  spawnTestEntity(): number {
    return this.sim.spawn_test_entity();
  }

  /** Buffer an input to apply on the next {@link PredictionSim.step}. */
  applyInput(sample: InputSample): void {
    this.sim.apply_input(sample.handle, sample.forward, sample.strafe, sample.turn);
  }

  /** Apply buffered inputs and advance one fixed tick. */
  step(): void {
    this.sim.step();
  }

  /**
   * Spawn a CAD-authored SimManifest (JSON) into this world, returning the
   * number of bodies spawned — the in-browser editor's path to simulate a
   * modelled part in the same authoritative sim (SPEC-4 FR-32).
   */
  spawnManifest(json: string): number {
    return this.sim.spawn_manifest(json);
  }

  /** Advance one fixed tick under gravity (the drop/run step for a part). */
  stepDynamics(): void {
    this.sim.step_dynamics();
  }

  /** Number of live bodies in the world. */
  get bodyCount(): number {
    return this.sim.body_count;
  }

  /** World position [x,y,z] of the body at `index` (empty array if absent). */
  bodyPosition(index: number): number[] {
    return Array.from(this.sim.body_position(index));
  }

  /** World orientation quaternion [x,y,z,w] of the body at `index`. */
  bodyOrientation(index: number): number[] {
    return Array.from(this.sim.body_orientation(index));
  }

  /** The current simulation tick. */
  get tick(): bigint {
    return this.sim.tick;
  }

  /** Canonical snapshot bytes of the current world. */
  snapshot(): Uint8Array {
    return this.sim.snapshot_bytes();
  }

  /** Replace the world with the state encoded in `bytes`. */
  restore(bytes: Uint8Array): void {
    this.sim.restore_from_bytes(bytes);
  }

  /**
   * Reconcile prediction with the server: rewind to the `authoritative`
   * snapshot, then replay the inputs the server has not yet acknowledged (one
   * tick each), re-deriving the predicted present from confirmed truth.
   */
  reconcile(authoritative: Uint8Array, replay: readonly InputSample[]): void {
    this.sim.restore_from_bytes(authoritative);
    for (const sample of replay) {
      this.sim.apply_input(sample.handle, sample.forward, sample.strafe, sample.turn);
      this.sim.step();
    }
  }

  /** Free the underlying wasm instance. */
  dispose(): void {
    this.sim.free();
  }
}
