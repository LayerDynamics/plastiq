// Read the current ring depth state from a RECM store: the active path, how many
// rings deep the selection reaches, and the configured cap. Derived values are
// computed outside the store selectors so the hook only re-renders when the
// underlying path/config references change.

import { clampMaxDepth } from "../config/depth.js";
import type { RecmStore } from "../store.js";

export interface RecmDepthState {
  activePath: readonly string[];
  depth: number;
  maxDepth: number;
  atMaxDepth: boolean;
}

export function useRecmDepth<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
): RecmDepthState {
  const activePath = store((state) => state.activePath);
  const maxDepth = store((state) => clampMaxDepth(state.config.maxDepth));
  const depth = activePath.length;
  return { activePath, depth, maxDepth, atMaxDepth: depth >= maxDepth };
}
