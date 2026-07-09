// Aggregate ring helpers over an expanded tree: fetch a ring by depth and flatten
// the tree back into ordered menu sections (the root ring's groups + items) for
// non-radial fallbacks or accessibility trees. Pure reads.

import { buildRecmSections } from "../../options.js";
import type {
  RecmContext,
  RecmMenuSection,
  RecmRingLevel,
  RecmTree,
} from "../../types.js";

/** The ring at `depth`, or null. */
export function ringAtDepth<TApp = unknown, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
  depth: number,
): RecmRingLevel<RecmContext<TApp>, TGroup> | null {
  return tree.rings[depth] ?? null;
}

/** The root ring (depth 0), or null when the menu resolved to nothing. */
export function rootRing<TApp = unknown, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
): RecmRingLevel<RecmContext<TApp>, TGroup> | null {
  return tree.rings[0] ?? null;
}

/**
 * Flatten the tree's root ring into ordered sections grouped by `group`. Uses
 * the tree's own activePath-carrying context so label functions resolve against
 * the same state the rings were built from.
 */
export function ringsToSections<TApp = unknown, TGroup extends string = string>(
  context: RecmContext<TApp>,
  tree: RecmTree<RecmContext<TApp>, TGroup>,
  groupOrder: readonly TGroup[] = [],
): RecmMenuSection<TGroup>[] {
  const root = tree.rings[0];
  if (!root) return [];
  return buildRecmSections(
    { ...context, activePath: tree.activePath, depth: 0 },
    root.options.map((resolved) => resolved.option),
    groupOrder,
  );
}
