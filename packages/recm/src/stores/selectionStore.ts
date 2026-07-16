// Selection slice: the current viewport selection the menu acts on. Kept as a
// dedicated slice so a host can push selection changes into the store
// independently of opening the menu (e.g. reflect the live 3D selection so the
// next right-click already knows what's picked).

import type { StoreApi } from "zustand";
import type { RecmSelection } from "../types.js";
import type { RecmStoreState } from "../store.js";

type SetState<TContext, TGroup extends string> = StoreApi<
  RecmStoreState<TContext, TGroup>
>["setState"];

export interface RecmSelectionSlice {
  selection: RecmSelection[];
  setSelection: (selection: readonly RecmSelection[]) => void;
}

export function createSelectionSlice<TContext, TGroup extends string = string>(
  set: SetState<TContext, TGroup>,
): RecmSelectionSlice {
  return {
    selection: [],
    setSelection: (selection) => set({ selection: [...selection] }),
  };
}
