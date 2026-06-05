// The pluggable physics contract. One PhysicsEngine interface, implemented by
// interchangeable backends (Rapier, ammo.js, cannon-es), selected at init time.

import type { SimManifest } from "./manifest.js";

export interface PhysicsPose {
  position: [number, number, number];
  orientation: [number, number, number, number];
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
