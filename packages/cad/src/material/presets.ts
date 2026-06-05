// Material presets (SPEC-4 FR-22): a catalog of common engineering materials in
// canonical SI. Values are representative reference figures (dry friction,
// typical restitution, room-temperature moduli) suitable as simulation defaults;
// a user can override any of them via the library.

import type { Material } from "./properties.js";

/**
 * The built-in catalog, keyed by a stable kebab-case id. Densities are exact
 * reference values; E/ν/yield are room-temperature engineering figures.
 */
export const MATERIAL_PRESETS: Readonly<Record<string, Material>> = {
  "structural-steel": {
    name: "structural-steel",
    density: 7850, // kg/m³
    friction: 0.6, // steel-on-steel, dry
    restitution: 0.6,
    youngsModulus: 200e9, // 200 GPa
    poissonRatio: 0.3,
    yieldStrength: 250e6, // 250 MPa (mild steel)
    appearance: { color: [0.56, 0.57, 0.58], metalness: 1, roughness: 0.4 },
  },
  "aluminum-6061": {
    name: "aluminum-6061",
    density: 2700,
    friction: 0.47,
    restitution: 0.4,
    youngsModulus: 69e9, // 69 GPa
    poissonRatio: 0.33,
    yieldStrength: 276e6, // 6061-T6
    appearance: { color: [0.83, 0.84, 0.85], metalness: 1, roughness: 0.35 },
  },
  abs: {
    name: "abs",
    density: 1050,
    friction: 0.35,
    restitution: 0.3,
    youngsModulus: 2.3e9, // 2.3 GPa
    poissonRatio: 0.35,
    yieldStrength: 40e6, // 40 MPa
    appearance: { color: [0.1, 0.1, 0.12], metalness: 0, roughness: 0.6 },
  },
  "titanium-ti6al4v": {
    name: "titanium-ti6al4v",
    density: 4430,
    friction: 0.36,
    restitution: 0.45,
    youngsModulus: 114e9, // 114 GPa
    poissonRatio: 0.34,
    yieldStrength: 880e6, // Ti-6Al-4V
    appearance: { color: [0.6, 0.6, 0.62], metalness: 1, roughness: 0.45 },
  },
  brass: {
    name: "brass",
    density: 8500,
    friction: 0.51,
    restitution: 0.5,
    youngsModulus: 100e9,
    poissonRatio: 0.34,
    yieldStrength: 200e6,
    appearance: { color: [0.71, 0.65, 0.26], metalness: 1, roughness: 0.4 },
  },
  pla: {
    name: "pla",
    density: 1240, // typical PLA filament
    friction: 0.4,
    restitution: 0.25,
    youngsModulus: 3.5e9,
    poissonRatio: 0.36,
    yieldStrength: 50e6,
    appearance: { color: [0.2, 0.55, 0.75], metalness: 0, roughness: 0.55 },
  },
};

/** Preset ids, sorted (deterministic iteration order — NFR-2). */
export const PRESET_NAMES: readonly string[] = Object.keys(MATERIAL_PRESETS).sort();
