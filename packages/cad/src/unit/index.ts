// SI unit conversion. The kernel works internally in metres and radians; these
// helpers convert authoring units into the SI values OCCT is fed.

/** Millimetres → metres. */
export function mm(value: number): number {
  return value / 1000;
}

/** Centimetres → metres. */
export function cm(value: number): number {
  return value / 100;
}

/** Metres → metres (identity, for symmetry/readability). */
export function m(value: number): number {
  return value;
}

/** Inches → metres. */
export function inch(value: number): number {
  return value * 0.0254;
}

/** Degrees → radians. */
export function deg(value: number): number {
  return (value * Math.PI) / 180;
}

/** Radians → radians (identity). */
export function rad(value: number): number {
  return value;
}

/** Metres → millimetres (for display/readback). */
export function toMm(metres: number): number {
  return metres * 1000;
}

/** Radians → degrees (for display/readback). */
export function toDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}
