// Snapshot the live cad + sketch stores into the pure shapes resolveContextTarget
// expects. Shared by the canvas right-click hook and the sketcher's own menu, so
// both build their ContextTarget the same way. Reads getState() only (runtime glue,
// exercised by the e2e suite — kept out of unit coverage like useCanvasRightClick).

import { useCadStore } from "../../store/store.js";
import { useSketchStore } from "../../sketch/sketchStore.js";
import type { CadSnapshot, SketchSnapshot } from "./contextSelection.js";

export function snapshotCad(): CadSnapshot {
  const s = useCadStore.getState();
  return {
    picks: s.picks,
    selMode: s.selMode,
    selectionRefs: s.selectionRefs,
    features: s.features,
    selectedFeatureId: s.selectedFeatureId,
    mateMode: s.mateMode,
    matePicks: s.matePicks,
    simulating: s.simulating,
    simPaused: s.simPaused,
    section: s.section,
    measuring: s.measuring,
    explodeFactor: s.explodeFactor,
    gizmoMode: s.gizmoMode,
  };
}

export function snapshotSketch(): SketchSnapshot {
  const s = useSketchStore.getState();
  return { active: s.active, selection: s.selection, solverReady: s.solverReady, model: s.model };
}
