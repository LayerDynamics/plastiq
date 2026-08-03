// §15 Lane A(c) — control-net edit helpers for freeform features.
//
// Pure document transforms: given a freeform feature's stored NurbsSurface JSON,
// move a control point and return the updated surface payload. The viewport can
// re-tessellate at 60 fps via pure-TS `tessellate` without a worker round-trip;
// commit to B-rep still goes through rebuild → freeformToFace / surfaceFromPoints.

import {
  moveControlPoint,
  type NurbsSurface,
  type FreeformVec3,
} from "@plastiq/cad";

/** A freeform surface payload as stored on `feature.data.surface`. */
export type FreeformSurfaceData = NurbsSurface;

/**
 * Apply a control-point drag to a freeform surface JSON.
 * Returns a new surface object (input is not mutated).
 */
export function dragControlPoint(
  surface: FreeformSurfaceData,
  i: number,
  j: number,
  position: FreeformVec3,
  weight?: number,
): FreeformSurfaceData {
  return moveControlPoint(surface, i, j, position, weight);
}

/**
 * Patch a freeform feature's `data.surface` after a control-point drag.
 * Returns new feature data (shallow-cloned with updated surface).
 */
export function featureDataAfterControlDrag(
  data: Record<string, unknown> | undefined,
  i: number,
  j: number,
  position: FreeformVec3,
  weight?: number,
): Record<string, unknown> {
  const surface = data?.["surface"] as FreeformSurfaceData | undefined;
  if (!surface || !Array.isArray(surface.controlNet)) {
    throw new Error("featureDataAfterControlDrag: freeform feature has no data.surface control net");
  }
  const next = dragControlPoint(surface, i, j, position, weight);
  return {
    ...(data ?? {}),
    kind: data?.["kind"] ?? "custom",
    surface: next,
  };
}
