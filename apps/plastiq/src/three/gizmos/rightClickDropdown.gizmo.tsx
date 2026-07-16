// The in-canvas right-click context menu gizmo (FR-27, viewport twin). Wires the
// canvas contextmenu event (useCanvasRightClick) and renders the resolved dynamic
// option sections as a world-anchored RECM radial menu.

import { useContextMenu } from "../contextmenu/contextMenuProvider.js";
import { useCanvasRightClick } from "../contextmenu/useCanvasRightClick.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";
import { PlastiqWorldContextMenu } from "../contextmenu/PlastiqContextMenu.js";

export function RightClickDropdownGizmo({
  part,
}: {
  part: BuiltPart | null;
}): React.JSX.Element | null {
  // Input: listen for right-clicks on the canvas, resolve + open the menu.
  useCanvasRightClick(part);

  const open = useContextMenu((s) => s.open);
  const anchor = useContextMenu((s) => s.anchor);
  const target = useContextMenu((s) => s.target);
  const close = useContextMenu((s) => s.close);

  // E2E seam: __plastiqViewport.gizmos.rightClickDropdown reflects open state.
  useGizmoPresence("rightClickDropdown", open);

  if (!open || !anchor) return null;
  return <PlastiqWorldContextMenu open={open} anchor={anchor} target={target} onClose={close} />;
}
