// Resolve a sketch's plane spec (datum id + offset) to a kernel DatumPlane.
// The editor stores a compiled `data.plane = { base, offset }` on each sketch
// feature; rebuild resolves it here so a profile builds on its real plane instead
// of always world-XY. Pure (no OCCT), so it's unit-tested in isolation.

import { offsetPlane, planeXY, planeXZ, planeYZ, type DatumPlane } from "@plastiq/cad";
import type { DatumPlaneId, SketchDatumSpec } from "../sketch/model.js";

const BASE: Record<DatumPlaneId, () => DatumPlane> = {
  XY: planeXY,
  XZ: planeXZ,
  YZ: planeYZ,
};

/**
 * The kernel DatumPlane for a base datum + offset (SI metres) along its normal.
 * Defaults to XY at offset 0, so a sketch feature with no stored plane (old docs
 * and the quick-add path) builds exactly as before.
 */
export function resolveDatumPlane(base: DatumPlaneId = "XY", offset = 0): DatumPlane {
  const make = BASE[base] ?? planeXY;
  return offsetPlane(make(), offset);
}

/** Convenience: resolve from a (possibly absent) datum plane spec. Face-derived
 * planes need the solid, so they're resolved in rebuild, not here. */
export function resolveSketchPlane(spec: SketchDatumSpec | undefined): DatumPlane {
  return resolveDatumPlane(spec?.base, spec?.offset);
}
