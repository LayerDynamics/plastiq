// Rendered-menus slice: the menus/rings currently on screen. Same id-keyed,
// last-write-wins register/unregister as the object slice, so nested or sibling
// menus can track their own presence (and depth) in one shared registry.

import type { StoreApi } from "zustand";
import type { RecmRenderedMenu } from "../types.js";
import type { RecmStoreState } from "../store.js";

type SetState<TContext, TGroup extends string> = StoreApi<
  RecmStoreState<TContext, TGroup>
>["setState"];

export interface RecmMenuSlice {
  renderedMenus: RecmRenderedMenu[];
  registerRenderedMenu: (menu: RecmRenderedMenu) => void;
  unregisterRenderedMenu: (id: string) => void;
}

export function createMenuSlice<TContext, TGroup extends string = string>(
  set: SetState<TContext, TGroup>,
): RecmMenuSlice {
  return {
    renderedMenus: [],
    registerRenderedMenu: (menu) =>
      set((state) => ({
        renderedMenus: [
          ...state.renderedMenus.filter((item) => item.id !== menu.id),
          menu,
        ],
      })),
    unregisterRenderedMenu: (id) =>
      set((state) => ({
        renderedMenus: state.renderedMenus.filter((item) => item.id !== id),
      })),
  };
}
