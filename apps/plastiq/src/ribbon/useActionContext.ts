// Build the ContextTarget the action registry's enabled/active/label read, from the
// current store slices. Shared by the slim TopBar and the sidebar WorkspacePanel so
// both grey/highlight identically — and it deliberately does NOT read simTicks (that
// would re-render every frame while simulating; the SimReadout widget owns that).

import { useCadStore } from "../store/store.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { resolveContextTarget, type ContextTarget } from "../three/contextmenu/contextSelection.js";

export function useActionContext(): ContextTarget {
  const picks = useCadStore((s) => s.picks);
  const selMode = useCadStore((s) => s.selMode);
  const selectionRefs = useCadStore((s) => s.selectionRefs);
  const features = useCadStore((s) => s.features);
  const selectedFeatureId = useCadStore((s) => s.selectedFeatureId);
  const mateMode = useCadStore((s) => s.mateMode);
  const matePicks = useCadStore((s) => s.matePicks);
  const simulating = useCadStore((s) => s.simulating);
  const simPaused = useCadStore((s) => s.simPaused);
  const section = useCadStore((s) => s.section);
  const measuring = useCadStore((s) => s.measuring);
  const explodeFactor = useCadStore((s) => s.explodeFactor);
  const gizmoMode = useCadStore((s) => s.gizmoMode);
  const sketchActive = useSketchStore((s) => s.active);
  const sketchSelection = useSketchStore((s) => s.selection);
  const solverReady = useSketchStore((s) => s.solverReady);
  const sketchModel = useSketchStore((s) => s.model);

  return resolveContextTarget({
    cad: {
      picks,
      selMode,
      selectionRefs,
      features,
      selectedFeatureId,
      mateMode,
      matePicks,
      simulating,
      simPaused,
      section,
      measuring,
      explodeFactor,
      gizmoMode,
    },
    sketch: { active: sketchActive, selection: sketchSelection, solverReady, model: sketchModel },
    hit: null,
    worldPoint: [0, 0, 0],
  });
}
