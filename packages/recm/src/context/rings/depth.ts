// Depth queries over an expanded tree: how many rings are actually shown vs the
// configured cap, and whether the menu can still grow. Complements config/depth
// (which bounds/validates depth against a config) with tree-derived answers.

import { clampMaxDepth } from "../../config/depth.js";
import type { RecmConfig, RecmContext, RecmTree } from "../../types.js";

/** How many rings the tree currently shows. */
export function resolvedDepth<TApp = unknown, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
): number {
  return tree.rings.length;
}

/** True when the deepest shown ring still has expandable options AND the config
 *  cap has not been reached — i.e. the menu could grow another ring. */
export function canExpand<TApp = unknown, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
  config: Pick<RecmConfig<TGroup>, "maxDepth">,
): boolean {
  if (tree.rings.length >= clampMaxDepth(config.maxDepth)) return false;
  const deepest = tree.rings[tree.rings.length - 1];
  if (!deepest) return false;
  return deepest.options.some((option) => option.hasChildren);
}
