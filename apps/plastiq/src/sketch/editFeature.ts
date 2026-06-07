// Shared "open the sketch editor for a feature" action, used by BOTH the
// feature-tree right-click menu (FR-27) and the in-canvas context menu, so the
// two surfaces can't drift. Re-enters the sketcher on the feature's own stored
// plane/offset + constrained model.

import type { EditorFeature } from "../store/types.js";
import { useCadStore } from "../store/store.js";
import { useSketchStore } from "./sketchStore.js";
import { extractProfile } from "./profile.js";
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

/**
 * COMMIT the active sketch (the "Finish" path, distinct from exitSketch which is
 * Cancel): solve, derive the closed profile, persist the constrained model +
 * profile + plane spec into the sketch feature (new, or the one being edited), then
 * leave sketch mode. Returns false (and stays in the sketcher) when the sketch has
 * no buildable profile yet. Shared by the Sketcher's Finish button + the ribbon /
 * context-menu "Finish sketch" so they can't diverge (and never discard work).
 */
export function finishSketchFeature(): boolean {
  const sketch = useSketchStore.getState();
  sketch.solve();
  const m = useSketchStore.getState().model;
  const profile = extractProfile(m);
  if (!profile) return false; // no buildable profile yet — stay in the sketcher
  // Build on the sketch's own plane — a base datum + offset, or a model face +
  // offset — rather than always world-XY (matches Sketcher.finishSketch).
  const plane = m.face
    ? { kind: "face" as const, face: m.face, offset: m.offset ?? 0 }
    : { base: m.plane, offset: m.offset ?? 0 };
  const data = { model: structuredClone(m), profile, plane };
  const cad = useCadStore.getState();
  if (sketch.editingFeatureId) cad.setFeatureData(sketch.editingFeatureId, data);
  else cad.addFeature({ type: "sketch", data });
  sketch.exitSketch();
  return true;
}
