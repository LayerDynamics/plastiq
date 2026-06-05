// Working/display units → canonical SI (SPEC-4 FR-23).
//
// The kernel stores and exports everything in SI (metres, radians) — matching
// crates/sim (SPEC-3 FR-1) and the SimManifest contract. CAD authors think in
// mm/cm/in and degrees; these helpers convert AT THE INPUT BOUNDARY so no SI
// value is ever held in display units. OCCT's native length unit is mm, so the
// mm↔m factor here is load-bearing (SPEC-4 A2).

/** Length in metres (the SI base the kernel/sim use). */
export type Metres = number;
/** Angle in radians (the SI base). */
export type Radians = number;

const MM_PER_M = 1000;
const CM_PER_M = 100;
const INCH_IN_M = 0.0254; // exact, by definition

/** Millimetres → metres. `mm(1000) === 1`. */
export function mm(value: number): Metres {
  return value / MM_PER_M;
}

/** Centimetres → metres. */
export function cm(value: number): Metres {
  return value / CM_PER_M;
}

/** Metres → metres (identity; for symmetry/clarity at call sites). */
export function m(value: number): Metres {
  return value;
}

/** Inches → metres. `inch(1) === 0.0254`. */
export function inch(value: number): Metres {
  return value * INCH_IN_M;
}

/** Degrees → radians. `deg(180) === Math.PI`. */
export function deg(value: number): Radians {
  return (value * Math.PI) / 180;
}

/** Radians → radians (identity). */
export function rad(value: number): Radians {
  return value;
}

/** Metres → millimetres (for display / OCCT-native output). */
export function toMm(value: Metres): number {
  return value * MM_PER_M;
}

/** Radians → degrees (for display). */
export function toDeg(value: Radians): number {
  return (value * 180) / Math.PI;
}
