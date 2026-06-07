// Shared open/close state for the canvas context menu. A Zustand store — NOT React
// Context — because the menu's input wiring (useCanvasRightClick, on the canvas
// element) and its renderer (the gizmo, mounted INSIDE the r3f <Canvas>) sit on
// opposite sides of the reconciler boundary that React Context does not cross.

import { create } from "zustand";
import { runContextAction } from "./config.js";
import type { ContextTarget } from "./contextSelection.js";
import type { MenuSection } from "./contextOptions.js";

interface ContextMenuState {
  open: boolean;
  /** drei <Html> world anchor (= target.worldPoint) while open. */
  anchor: [number, number, number] | null;
  target: ContextTarget | null;
  sections: MenuSection[];
  /** Open the menu for a resolved target with its pre-built sections. */
  openAt: (target: ContextTarget, sections: MenuSection[]) => void;
  close: () => void;
  /** Run a catalog action by id against the open target, then close. */
  runAction: (id: string) => void;
}

export const useContextMenu = create<ContextMenuState>((set, get) => ({
  open: false,
  anchor: null,
  target: null,
  sections: [],
  openAt: (target, sections) =>
    set({ open: true, anchor: target.worldPoint, target, sections }),
  close: () => set({ open: false, anchor: null, target: null, sections: [] }),
  runAction: (id) => {
    const { target } = get();
    // Honour the same precondition the menu rendered disabled — never run a
    // greyed item even if something dispatches it.
    if (target) runContextAction(id, target);
    get().close();
  },
}));

// Read-only E2E seam: lets the no-mock specs assert the open menu's resolved
// target + sections (the menu DOM lives inside the WebGL canvas via drei <Html>).
if (typeof globalThis !== "undefined") {
  (globalThis as { __plastiqContextMenu?: typeof useContextMenu }).__plastiqContextMenu =
    useContextMenu;
}
