// Shared presentational context menu: grouped action buttons with dividers, the
// dark feature-tree styling, danger accent, and disabled states. Used by both the
// canvas gizmo (inside drei <Html>, world-anchored) and the sketcher overlay
// (fixed DOM, screen-anchored) so the two menus look + behave identically.
// Keyboard: auto-focuses the first item; ↑/↓ rove enabled items, Enter activates
// (native button), Escape closes.

import { useEffect, useRef } from "react";
import type { MenuSection } from "./contextOptions.js";

const ITEM =
  "block w-full px-3 py-1 text-left text-xs text-[#cfe] enabled:hover:bg-[#1f2a3a] focus:bg-[#1f2a3a] focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed";
const DANGER_ITEM =
  "block w-full px-3 py-1 text-left text-xs text-[#ff8a8a] enabled:hover:bg-[#2a1717] focus:bg-[#2a1717] focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed";

export function ContextMenuView({
  sections,
  onRun,
  onClose,
  testid = "canvas-context-menu",
}: {
  sections: MenuSection[];
  onRun: (id: string) => void;
  onClose?: () => void;
  testid?: string;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // Focus the first actionable item so the menu is keyboard-drivable on open.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [sections]);

  const enabledButtons = (): HTMLButtonElement[] =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      onClose?.();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = enabledButtons();
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      data-testid={testid}
      role="menu"
      tabIndex={-1}
      className="min-w-40 select-none rounded border border-[#2a3444] bg-[#0e1219] py-1 shadow-lg"
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
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
