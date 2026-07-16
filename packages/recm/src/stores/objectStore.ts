// Rendered-objects slice: the live scene inventory the menu can target (parts,
// mesh bodies, assembly instances). Register/unregister are id-keyed and
// last-write-wins so a component can (un)publish itself on mount/unmount without
// racing duplicates into the list.

import type { StoreApi } from "zustand";
import type { RecmRenderedObject } from "../types.js";
import type { RecmStoreState } from "../store.js";

type SetState<TContext, TGroup extends string> = StoreApi<
  RecmStoreState<TContext, TGroup>
>["setState"];

export interface RecmObjectSlice {
  renderedObjects: RecmRenderedObject[];
  registerRenderedObject: (object: RecmRenderedObject) => void;
  unregisterRenderedObject: (id: string) => void;
}

export function createObjectSlice<TContext, TGroup extends string = string>(
  set: SetState<TContext, TGroup>,
): RecmObjectSlice {
  return {
    renderedObjects: [],
    registerRenderedObject: (object) =>
      set((state) => ({
        renderedObjects: [
          ...state.renderedObjects.filter((item) => item.id !== object.id),
          object,
        ],
      })),
    unregisterRenderedObject: (id) =>
      set((state) => ({
        renderedObjects: state.renderedObjects.filter((item) => item.id !== id),
      })),
  };
}
