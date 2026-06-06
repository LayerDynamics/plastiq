// View cube (FR-12): the in-scene orientation cube. Clicking a face/edge/corner
// tweens the camera to that standard view (drei drives the default OrbitControls).
// Themed to the viewport palette with the orange hover accent.

import { GizmoHelper, GizmoViewcube } from "@react-three/drei";
import { GRID_CELL, SELECT_ORANGE } from "../colors.js";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

export function ViewCubeGizmo(): React.JSX.Element {
  return (
    <GizmoHelper alignment="top-right" margin={[64, 64]}>
      <GizmoViewcube
        color={hex(GRID_CELL)}
        textColor="#cfe"
        strokeColor="#2a3444"
        hoverColor={hex(SELECT_ORANGE)}
      />
    </GizmoHelper>
  );
}
