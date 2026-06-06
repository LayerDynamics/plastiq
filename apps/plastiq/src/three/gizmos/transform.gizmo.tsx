// Transform gizmo (FR-11): move/rotate the body with drei's TransformControls,
// shown only when something is selected, its mode driven by the store (Move/
// Rotate). A drag never does a free mesh move — on release the group's transform
// is read back and committed as a parametric placement feature, exactly like the
// legacy SceneController gizmo.

import { useEffect } from "react";
import { TransformControls } from "@react-three/drei";
import { useCadStore } from "../../store/store.js";
import { placementParams, readPlacement } from "../../viewport/placement.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";

/** Mounted only while the gizmo is shown; flags it for the E2E seam. */
function GizmoPresence(): null {
  useEffect(() => {
    const g = globalThis as { __plastiqViewport?: { transformGizmoActive?: boolean } };
    (g.__plastiqViewport ??= {}).transformGizmoActive = true;
    return () => {
      if (g.__plastiqViewport) g.__plastiqViewport.transformGizmoActive = false;
    };
  }, []);
  return null;
}

export function TransformGizmo({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  const pickCount = useCadStore((s) => s.picks.length);
  const gizmoMode = useCadStore((s) => s.gizmoMode);
  if (!part || pickCount === 0) return null;
  return (
    <>
      <GizmoPresence />
      <TransformControls
        object={part.group}
        mode={gizmoMode}
        // drag end → persist the new pose as a parametric placement (one undo step,
        // no free mesh move). upsertPlacement keeps geometry identical (no rebuild).
        onMouseUp={() => {
          useCadStore.getState().upsertPlacement(placementParams(readPlacement(part.group)));
        }}
      />
    </>
  );
}
