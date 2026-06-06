// @plastiq/sim — pluggable in-browser physics for Plastiq.
//
// One PhysicsEngine interface with three interchangeable backends — Rapier
// (@dimforge/rapier3d-compat), ammo.js (Bullet, via ammojs-typed), and cannon-es
// — selectable at runtime. initSim() loads a backend; PredictionSim spawns a
// SimManifest and steps it under gravity, reporting each body's world COM pose.

/** Sim layer version, surfaced for tooling/diagnostics. */
export const SIM_VERSION = "0.1.0" as const;

export { initSim, activeBackend, PredictionSim } from "./prediction.js";
export type {
  PhysicsEngine,
  PhysicsBackend,
  PhysicsPose,
  PhysicsSnapshot,
  BodyState,
  BackendName,
} from "./engine.js";
export {
  type SimManifest,
  type ManifestBody,
  type ManifestConstraint,
  parseManifest,
} from "./manifest.js";
