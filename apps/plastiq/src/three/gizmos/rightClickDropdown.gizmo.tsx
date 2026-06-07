// The in-canvas right-click context menu gizmo (FR-27, viewport twin). Wires the
// canvas contextmenu event (useCanvasRightClick) and renders the resolved options
// as a DOM dropdown via drei <Html>, world-anchored at the 3D point that was
// clicked so it tracks the camera. Styling mirrors the feature-tree menu
// (FeatureContextMenu) for a consistent dark theme + orange/red accents.

import { Html } from "@react-three/drei";
import { useContextMenu } from "../contextmenu/contextMenuProvider.js";
import { useCanvasRightClick } from "../contextmenu/useCanvasRightClick.js";
import { ContextMenuView } from "../contextmenu/ContextMenuView.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";

export function RightClickDropdownGizmo({
  part,
}: {
  part: BuiltPart | null;
}): React.JSX.Element | null {
  // Input: listen for right-clicks on the canvas, resolve + open the menu.
  useCanvasRightClick(part);

  const open = useContextMenu((s) => s.open);
  const anchor = useContextMenu((s) => s.anchor);
  const sections = useContextMenu((s) => s.sections);
  const runAction = useContextMenu((s) => s.runAction);

  // E2E seam: __plastiqViewport.gizmos.rightClickDropdown reflects open state.
  useGizmoPresence("rightClickDropdown", open);

  if (!open || !anchor) return null;
  return (
    <Html position={anchor} zIndexRange={[1000, 0]} pointerEvents="auto" wrapperClass="ctx-menu-wrap">
      <ContextMenuView sections={sections} onRun={runAction} />
    </Html>
  );
}
