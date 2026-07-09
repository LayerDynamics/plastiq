// Read the rendered-menu registry from a RECM store, plus a lifecycle hook
// (`useRegisterRecmMenu`) that publishes a menu/ring's presence + depth while it
// is mounted. Lets nested menus advertise themselves so context modifiers can
// reason about how deep the on-screen menu stack currently is.

import { useEffect } from "react";
import type { RecmRenderedMenu } from "../types.js";
import type { RecmStore } from "../store.js";

export interface RecmRenderedMenusState {
  renderedMenus: RecmRenderedMenu[];
  register: (menu: RecmRenderedMenu) => void;
  unregister: (id: string) => void;
}

export function useRecmRenderedMenus<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
): RecmRenderedMenusState {
  const renderedMenus = store((state) => state.renderedMenus);
  const register = store((state) => state.registerRenderedMenu);
  const unregister = store((state) => state.unregisterRenderedMenu);
  return { renderedMenus, register, unregister };
}

/** Keep `menu` registered in the store for the caller's lifetime (id-keyed,
 *  last-write-wins). Re-registers when the menu's identity/depth changes. */
export function useRegisterRecmMenu<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
  menu: RecmRenderedMenu,
): void {
  const register = store((state) => state.registerRenderedMenu);
  const unregister = store((state) => state.unregisterRenderedMenu);
  useEffect(() => {
    register(menu);
    return () => unregister(menu.id);
  }, [register, unregister, menu, menu.id, menu.kind, menu.depth]);
}
