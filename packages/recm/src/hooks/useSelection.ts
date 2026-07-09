// Read + write the viewport selection held in a RECM store. Returns the live
// selection, a bound setter, and cheap derived flags. Derived values are
// computed in the hook body (not in a store selector) so re-renders track only
// the selection reference.

import type { RecmSelection } from "../types.js";
import type { RecmStore } from "../store.js";

export interface RecmSelectionState {
  selection: RecmSelection[];
  setSelection: (selection: readonly RecmSelection[]) => void;
  hasSelection: boolean;
  count: number;
}

export function useRecmSelection<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
): RecmSelectionState {
  const selection = store((state) => state.selection);
  const setSelection = store((state) => state.setSelection);
  return {
    selection,
    setSelection,
    hasSelection: selection.length > 0,
    count: selection.length,
  };
}
