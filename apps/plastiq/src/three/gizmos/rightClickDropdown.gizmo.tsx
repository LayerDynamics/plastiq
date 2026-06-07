// The in-canvas right-click context menu gizmo (FR-27, viewport twin). Wires the
// canvas contextmenu event (useCanvasRightClick) and renders the resolved options
// as a DOM dropdown via drei <Html>, world-anchored at the 3D point that was
// clicked so it tracks the camera. Styling mirrors the feature-tree menu
// (FeatureContextMenu) for a consistent dark theme + orange/red accents.

import { Html } from "@react-three/drei";
import { useContextMenu } from "../contextmenu/contextMenuProvider.js";
import { useCanvasRightClick } from "../contextmenu/useCanvasRightClick.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";

const ITEM =
  "block w-full px-3 py-1 text-left text-xs text-[#cfe] enabled:hover:bg-[#1f2a3a] disabled:opacity-40 disabled:cursor-not-allowed";
const DANGER_ITEM =
  "block w-full px-3 py-1 text-left text-xs text-[#ff8a8a] enabled:hover:bg-[#2a1717] disabled:opacity-40 disabled:cursor-not-allowed";

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
    <Html
      position={anchor}
      zIndexRange={[1000, 0]}
      pointerEvents="auto"
      wrapperClass="ctx-menu-wrap"
    >
      <div
        data-testid="canvas-context-menu"
        role="menu"
        className="min-w-40 select-none rounded border border-[#2a3444] bg-[#0e1219] py-1 shadow-lg"
        onContextMenu={(e) => e.preventDefault()}
        // Keep pointer gestures on the menu from reaching the canvas/OrbitControls
        // underneath (which would "start" an orbit and dismiss the menu before the
        // item's click lands). React stops the native event too, so the canvas
        // pointerdown-to-close + controls "start" never fire for in-menu clicks.
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        {sections.map((sec, si) => (
          <div key={sec.group}>
            {si > 0 && <div className="my-1 border-t border-[#2a3444]" />}
            {sec.items.map((it) => (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                data-testid={`ctx-${it.id}`}
                disabled={!it.enabled}
                className={it.danger ? DANGER_ITEM : ITEM}
                onClick={() => runAction(it.id)}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Html>
  );
}
