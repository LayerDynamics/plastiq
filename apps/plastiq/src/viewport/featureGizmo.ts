// Pure model for the interactive feature-edit gizmo (FR-11 extension). The gizmo
// edits a feature's primary numeric param live (extrude height, cut depth, revolve
// angle, fillet radius, …). Everything here is pure (plain numbers) so it unit-tests
// in Node, mirroring sectionTFromOffset — the 3D drag gesture and the DOM scrub are
// not E2E-tested (flaky/awkward headless); their math lives here and IS tested.

/** Display unit for a param: linear params show in mm, angular params in degrees. */
export type EditUnit = "mm" | "deg";

/** Which param a feature type exposes to the gizmo, its unit, and whether it gets a
 * world-space drag arrow (only meaningful for axis-aligned LINEAR ops along the
 * sketch normal). Angular ops and selection-driven dress-up edit via the value box
 * + scrub instead (no natural world axis). Single source of truth — both the action
 * catalog (to open the edit) and the gizmo (to render it) read this. */
export interface FeatureEditSpec {
  param: string;
  unit: EditUnit;
  /** true → show the draggable arrow along the sketch normal (extrude/cut). */
  world: boolean;
}

export const FEATURE_EDIT_SPECS: Record<string, FeatureEditSpec> = {
  extrude: { param: "height", unit: "mm", world: true },
  cut: { param: "depth", unit: "mm", world: true },
  revolve: { param: "angle", unit: "deg", world: false },
  fillet: { param: "radius", unit: "mm", world: false },
  chamfer: { param: "distance", unit: "mm", world: false },
  shell: { param: "thickness", unit: "mm", world: false },
  draft: { param: "angle", unit: "deg", world: false },
};

/**
 * Secondary params editable via properties/gizmo scrub (T16): not the primary
 * world-drag axis, but available for value-box / multi-param edit UIs.
 * `back` is SI metres; pattern spacing/count as named.
 */
export const FEATURE_SECONDARY_PARAMS: Record<string, readonly string[]> = {
  extrude: ["back"],
  cut: ["back"],
  linearPattern: ["spacing", "count"],
  circularPattern: ["count", "angle"],
  pathPattern: ["count"],
  fillet: ["radius2"],
  chamfer: ["distance2"],
  loft: [],
  revolve: [],
};

/** Floor (SI: metres or radians) so an edited feature never collapses to zero (or
 * inverts) as the value is dragged/scrubbed/typed down. */
export const MIN_SI = 5e-4;

/** SI value → display number (mm for lengths, degrees for angles). */
export function toDisplayUnit(valueSI: number, unit: EditUnit): number {
  return unit === "deg" ? (valueSI * 180) / Math.PI : valueSI * 1000;
}

/** Display number (mm or degrees) → SI value (metres or radians). */
export function fromDisplayUnit(display: number, unit: EditUnit): number {
  return unit === "deg" ? (display * Math.PI) / 180 : display / 1000;
}

/**
 * The feature value for a handle dragged to `handleAxisCoord` along the gizmo's
 * unit axis, given the fixed `anchorAxisCoord` (both are world points projected
 * onto the axis, i.e. `point · axis`). The value is the signed extent from the
 * anchor to the handle, floored at `min` so the solid keeps a sliver of thickness
 * (and never inverts) when the handle is dragged back to or past the anchor.
 */
export function featureDragValue(
  anchorAxisCoord: number,
  handleAxisCoord: number,
  min: number,
): number {
  return Math.max(handleAxisCoord - anchorAxisCoord, min);
}

/** Pixels of horizontal drag per one display unit when scrubbing the value box.
 * Coarser for angles (a full sweep shouldn't need a giant drag). */
const SCRUB_PX_PER_UNIT: Record<EditUnit, number> = { mm: 4, deg: 3 };

/**
 * Scrub write-back: a horizontal drag of `dxPx` from where the scrub began (display
 * value `startDisplay`) yields a new SI value, floored at {@link MIN_SI}. Drag right
 * (dx > 0) → larger. Returned in SI so the caller writes it straight to the param.
 */
export function scrubToSI(startDisplay: number, dxPx: number, unit: EditUnit): number {
  const display = startDisplay + dxPx / SCRUB_PX_PER_UNIT[unit];
  return Math.max(fromDisplayUnit(display, unit), MIN_SI);
}
