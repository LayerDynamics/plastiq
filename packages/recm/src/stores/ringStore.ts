// Ring-navigation slice: which root group is active and the outward active path
// through the rings. `setActiveGroup` resets the path to that group (a fresh
// root choice collapses any deeper expansion), matching the radial menu's "pick
// a category, then reach outward" interaction.

import type { StoreApi } from "zustand";
import type { RecmStoreState } from "../store.js";

type SetState<TContext, TGroup extends string> = StoreApi<
  RecmStoreState<TContext, TGroup>
>["setState"];

export interface RecmRingSlice<TGroup extends string = string> {
  activeGroup: TGroup | null;
  activePath: string[];
  setActiveGroup: (group: TGroup) => void;
}

export function createRingSlice<TContext, TGroup extends string = string>(
  set: SetState<TContext, TGroup>,
): RecmRingSlice<TGroup> {
  return {
    activeGroup: null,
    activePath: [],
    setActiveGroup: (group) => set({ activeGroup: group, activePath: [group] }),
  };
}
