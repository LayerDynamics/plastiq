// @plastiq/sim — pluggable in-browser physics for Plastiq.
//
// One PhysicsEngine interface with three interchangeable backends — Rapier
// (@dimforge/rapier3d), ammo.js (Bullet, via ammojs-typed), and cannon-es —
// selectable at runtime. Re-shapes the app's initSim/PredictionSim usage over
// the common interface.
//
// The interface and backends are implemented in milestone R6 (no stubs); they
// are re-exported here as they land.

/** Sim layer version, surfaced for tooling/diagnostics. */
export const SIM_VERSION = "0.1.0" as const;
