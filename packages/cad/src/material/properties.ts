// Material properties (SPEC-4 FR-22). A `Material` carries the full physical
// description in canonical SI: the dynamics-relevant trio the sim seam consumes
// (density, friction, restitution) plus structural properties (Young's modulus,
// Poisson's ratio, yield strength) and a PBR appearance for the renderer.

import type { MaterialData } from "../lower/manifest.js";

/** PBR surface appearance (Babylon-friendly): linear RGB in [0,1] + PBR scalars. */
export interface Appearance {
  readonly color: readonly [number, number, number];
  readonly metalness: number; // [0,1]
  readonly roughness: number; // [0,1]
}

/** A named material in canonical SI units. */
export interface Material {
  readonly name: string;
  /** Mass density, kg/m³. */
  readonly density: number;
  /** Coulomb friction coefficient, dimensionless, ≥ 0. */
  readonly friction: number;
  /** Coefficient of restitution, [0, 1]. */
  readonly restitution: number;
  /** Young's modulus E, Pa. */
  readonly youngsModulus: number;
  /** Poisson's ratio ν, dimensionless, (−1, 0.5). */
  readonly poissonRatio: number;
  /** Yield strength, Pa. */
  readonly yieldStrength: number;
  readonly appearance: Appearance;
}

/**
 * Lower a full `Material` to the manifest's `MaterialData` — the four fields the
 * sim seam needs (`mechx_sim::Material { density, friction, restitution }` plus
 * the name). Structural/appearance properties stay CAD-side.
 */
export function toMaterialData(m: Material): MaterialData {
  return {
    name: m.name,
    density: m.density,
    friction: m.friction,
    restitution: m.restitution,
  };
}
