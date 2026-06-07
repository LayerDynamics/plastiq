// Shared presentational context menu: grouped action buttons with dividers, the
// dark feature-tree styling, danger accent, and disabled states. Used by both the
// canvas gizmo (inside drei <Html>, world-anchored) and the sketcher overlay
// (fixed DOM, screen-anchored) so the two menus look + behave identically.

import type { MenuSection } from "./contextOptions.js";

const ITEM =
  "block w-full px-3 py-1 text-left text-xs text-[#cfe] enabled:hover:bg-[#1f2a3a] disabled:opacity-40 disabled:cursor-not-allowed";
const DANGER_ITEM =
  "block w-full px-3 py-1 text-left text-xs text-[#ff8a8a] enabled:hover:bg-[#2a1717] disabled:opacity-40 disabled:cursor-not-allowed";

export function ContextMenuView({
  sections,
  onRun,
  testid = "canvas-context-menu",
}: {
  sections: MenuSection[];
  onRun: (id: string) => void;
  testid?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={testid}
      role="menu"
      className="min-w-40 select-none rounded border border-[#2a3444] bg-[#0e1219] py-1 shadow-lg"
      onContextMenu={(e) => e.preventDefault()}
      // Keep pointer gestures on the menu from reaching the canvas/OrbitControls
      // underneath (which would "start" an orbit and dismiss the menu before the
      // item's click lands). React stops the native event too.
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
              onClick={() => onRun(it.id)}
            >
              {it.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
