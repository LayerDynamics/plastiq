// @plastiq/cad — parametric CAD modeling kernel (SPEC-4).
//
// TypeScript kernel built on opencascade.js (full OCCT compiled to WASM). Owns
// geometry types, feature actions, sketch + assembly-mate solvers, hierarchy,
// materials, units, the parametric feature-history engine, and the sim-export
// (lowering) step. Runs in the browser and headless under Node from one WASM
// engine. See docs/specs/SPEC-4-cad-modeling-kernel.md.

/** Kernel version, surfaced for tooling/diagnostics. */
export const CAD_KERNEL_VERSION = "0.1.0" as const;

// Public API. (math/unit are intentionally NOT re-exported from the root: their
// mutable Vec3/Quat/Mat3 would collide with the manifest's readonly contract
// types — import them from "@plastiq/cad/.../math" if needed.)
//
// SI unit conversion (mm/cm/m/inch/deg/rad). (math is still NOT re-exported.)
export * from "./unit/index.js";
// Engine + geometry core.
export * from "./oc/init.js";
export * from "./oc/arena.js";
export * from "./solid/solid.js";
export * from "./solid/primitives.js";
export * from "./mesh/tessellate.js";
export * from "./mesh/tagged.js";
// Sketch, environment, features, hierarchy.
export * from "./sketch/index.js";
export * from "./environment/index.js";
export * from "./action/index.js";
export * from "./hierarchy/index.js";
// Materials, assembly, lowering, model, interchange I/O.
export * from "./material/index.js";
export * from "./lower/index.js";
export * from "./assembly/index.js";
export * from "./io/index.js";
export * from "./model/index.js";
