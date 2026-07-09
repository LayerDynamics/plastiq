// Read the resolved menu sections + flattened option ids from a RECM store,
// along with the active group and a bound setter. Lets a non-radial/accessible
// menu render off the same resolved options the radial view uses.

import { recmItemIds } from "../options.js";
import type { RecmMenuSection } from "../types.js";
import type { RecmStore } from "../store.js";

export interface RecmOptionsState<TGroup extends string = string> {
  sections: RecmMenuSection<TGroup>[];
  itemIds: string[];
  activeGroup: TGroup | null;
  setActiveGroup: (group: TGroup) => void;
}

export function useRecmOptions<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
): RecmOptionsState<TGroup> {
  const sections = store((state) => state.sections);
  const activeGroup = store((state) => state.activeGroup);
  const setActiveGroup = store((state) => state.setActiveGroup);
  return { sections, itemIds: recmItemIds(sections), activeGroup, setActiveGroup };
}
