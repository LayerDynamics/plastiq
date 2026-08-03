// §15 Lane A(c) — control-net edit helpers for freeform features.
//
// Pure document transforms: given a freeform feature's stored NurbsSurface JSON,
// move a control point and return the updated surface payload. The viewport can
// re-tessellate at 60 fps via pure-TS `tessellate` without a worker round-trip;
// commit to B-rep still goes through rebuild → freeformToFace / surfaceFromPoints.

import {
  cylinderSurface,
  moveControlPoint,
  planeSurface,
  sphereSurface,
  type NurbsSurface,
  type FreeformVec3,
} from "@plastiq/cad";
import type { EditorFeature } from "../store/types.js";

/** A freeform surface payload as stored on `feature.data.surface`. */
export type FreeformSurfaceData = NurbsSurface;

function tuple3(raw: unknown, fallback: FreeformVec3): FreeformVec3 {
  return Array.isArray(raw) && raw.length >= 3
    ? [Number(raw[0]), Number(raw[1]), Number(raw[2])]
    : fallback;
}

/** Resolve the live net displayed for a freeform feature. Primitive nets are
 * regenerated from current Properties parameters so the overlay never shows
 * stale creation-time poles. Custom/service surfaces use stored JSON directly. */
export function editableSurfaceFromFeature(feature: EditorFeature): FreeformSurfaceData | null {
  if (feature.type !== "freeform") return null;
  const kind = feature.data?.["kind"];
  const p = feature.params ?? {};
  const origin: FreeformVec3 = [p["ox"] ?? 0, p["oy"] ?? 0, p["oz"] ?? 0];
  if (kind === "plane" && p["uSize"] !== undefined && p["vSize"] !== undefined) {
    return planeSurface(
      origin,
      tuple3(feature.data?.["uDir"], [1, 0, 0]),
      tuple3(feature.data?.["vDir"], [0, 1, 0]),
      p["uSize"],
      p["vSize"],
    );
  }
  if (kind === "cylinder" && p["radius"] !== undefined && p["height"] !== undefined) {
    return cylinderSurface(
      origin,
      [p["ax"] ?? 0, p["ay"] ?? 0, p["az"] ?? 1],
      p["radius"],
      p["height"],
    );
  }
  if (kind === "sphere" && p["radius"] !== undefined) {
    return sphereSurface(origin, p["radius"]);
  }
  const surface = feature.data?.["surface"] as FreeformSurfaceData | undefined;
  return surface && Array.isArray(surface.controlNet) ? surface : null;
}

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
    throw new Error(
      "featureDataAfterControlDrag: freeform feature has no data.surface control net",
    );
  }
  const next = dragControlPoint(surface, i, j, position, weight);
  return {
    ...(data ?? {}),
    // The first pole edit freezes a parametric plane/cylinder/sphere into an
    // editable custom net. Leaving the primitive kind here makes rebuild
    // regenerate from size/radius params and silently discard this drag.
    kind: "custom",
    surface: next,
  };
}
