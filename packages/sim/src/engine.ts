// The pluggable physics contract. One PhysicsEngine interface, implemented by
// interchangeable backends (Rapier, ammo.js, cannon-es), selected at init time.

import type { SimManifest } from "./manifest.js";

export interface PhysicsPose {
  position: [number, number, number];
  orientation: [number, number, number, number];
}

/** The full dynamic state of one body — pose AND velocities, so restoring it
 * reproduces the simulation forward from this point (pose alone would discard the
 * momentum and diverge). */
export interface BodyState {
  position: [number, number, number];
  orientation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
}

/** A capture of every spawned body's full state, in spawn order. Snapshot a world,
 * step it, and `restore()` to rewind to that exact state (save/rewind/replay). */
export interface PhysicsSnapshot {
  readonly bodies: BodyState[];
}

export interface PhysicsEngine {
  /** Number of spawned bodies. */
  readonly bodyCount: number;
  /** Build the world from a manifest (gravity + bodies + constraints). Returns body count. */
  spawn(manifest: SimManifest): number;
  /** Advance one fixed timestep. */
  step(): void;
  /** Current world pose (COM position + orientation) of spawned body `index`. */
  pose(index: number): PhysicsPose;
  /** Capture every body's full dynamic state (pose + velocities), in spawn order. */
  snapshot(): PhysicsSnapshot;
  /** Restore every body to a previously captured snapshot (same body count). */
  restore(snapshot: PhysicsSnapshot): void;
  /** Release any native/wasm resources. */
  dispose(): void;
}

export type BackendName = "rapier" | "ammo" | "cannon";

export interface PhysicsBackend {
  readonly name: BackendName;
  /** Load the backend (wasm init etc.). Idempotent. */
  init(): Promise<void>;
  /** Create a fresh engine bound to a fixed `timestep` (seconds). */
  createEngine(timestep: number): PhysicsEngine;
}
