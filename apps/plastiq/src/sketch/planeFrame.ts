// Resolve the live sketch DatumPlane for an in-place session (ADR-0014).
// Datum planes resolve sync; face planes are supplied by the viewport/worker
// (async) and cached on the session as `liveFrame`.

import type { DatumPlane } from "@plastiq/cad";
import { resolveDatumPlane } from "../worker/sketchPlane.js";
import type { SketchModel } from "./model.js";

/**
 * Synchronous plane for the active model when it is **not** face-based.
 * Face sketches return null — the viewport must supply the worker-resolved frame.
 */
export function syncPlaneFrame(model: SketchModel): DatumPlane | null {
  if (model.face) return null;
  return resolveDatumPlane(model.plane, model.offset ?? 0);
}

/**
 * Prefer an explicit live frame (face resolve / parent); fall back to datum sync.
 */
export function effectivePlaneFrame(
  model: SketchModel,
  liveFrame: DatumPlane | null | undefined,
): DatumPlane | null {
  if (liveFrame) return liveFrame;
  return syncPlaneFrame(model);
}
