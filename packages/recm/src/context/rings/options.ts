// Per-ring option queries over an expanded tree: what options sit on a ring,
// which is active, and which terminal option a full path resolves to (the one
// that actually runs). Pure reads over a RecmTree.

export { resolveRecmOptions } from "../../options.js";
import type {
  RecmContext,
  RecmResolvedOption,
  RecmRingLevel,
  RecmTree,
} from "../../types.js";

/** The resolved options on the ring at `depth`, or [] if that ring isn't shown. */
export function ringOptions<TApp = unknown, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
  depth: number,
): readonly RecmResolvedOption<RecmContext<TApp>, TGroup>[] {
  return tree.rings[depth]?.options ?? [];
}

/** The active option on a ring (the one the path points at), else the first. */
export function activeOption<TApp = unknown, TGroup extends string = string>(
  ring: RecmRingLevel<RecmContext<TApp>, TGroup>,
): RecmResolvedOption<RecmContext<TApp>, TGroup> | null {
  return ring.options.find((option) => option.id === ring.activeId) ?? ring.options[0] ?? null;
}

/** Find a resolved option by id anywhere in the tree, with the ring depth it
 *  was found at (−1 depth when absent). */
export function findOption<TApp = unknown, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
  id: string,
): { option: RecmResolvedOption<RecmContext<TApp>, TGroup>; depth: number } | null {
  for (const ring of tree.rings) {
    const option = ring.options.find((candidate) => candidate.id === id);
    if (option) return { option, depth: ring.depth };
  }
  return null;
}

/** The terminal (leaf) option the tree resolves to along its active path: the
 *  deepest ring's active option when it has no children. This is what `run`
 *  executes when the user commits the current path. */
export function terminalOption<TApp = unknown, TGroup extends string = string>(
  tree: RecmTree<RecmContext<TApp>, TGroup>,
): RecmResolvedOption<RecmContext<TApp>, TGroup> | null {
  const deepest = tree.rings[tree.rings.length - 1];
  if (!deepest) return null;
  const option = activeOption(deepest);
  return option && !option.hasChildren ? option : null;
}
