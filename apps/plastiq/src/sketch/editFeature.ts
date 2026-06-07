// Shared "open the sketch editor for a feature" action, used by BOTH the
// feature-tree right-click menu (FR-27) and the in-canvas context menu, so the
// two surfaces can't drift. Re-enters the sketcher on the feature's own stored
// plane/offset + constrained model.

import type { EditorFeature } from "../store/types.js";
import { useSketchStore } from "./sketchStore.js";
import type { SketchModel } from "./model.js";

/**
 * Open the sketch editor for a sketch feature that carries a model. Returns
 * whether it did (false = not an editable sketch, so callers can fall back, e.g.
 * to inline rename in the tree).
 */
export function editSketchFeature(feature: EditorFeature): boolean {
  if (feature.type === "sketch" && feature.data?.["model"] != null) {
    const m = feature.data["model"] as SketchModel;
    useSketchStore.getState().enterSketch(m.plane, m.offset ?? 0, feature.id, m);
    return true;
  }
  return false;
}
