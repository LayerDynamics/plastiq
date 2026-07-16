// Group-ordering policy for the root ring. `orderGroups` is the canonical rule
// used both by buildRecmSections (flat engine) and the context subsystem:
// listed groups first in the given order, then any unlisted groups sorted
// alphabetically for a stable, deterministic layout.

export { DEFAULT_GROUP_ORDER } from "../config.js";

/**
 * Order a set of present groups by a preferred `order`:
 *   - groups named in `order` come first, in that order (only if present),
 *   - remaining groups follow, sorted alphabetically (stable & deterministic).
 */
export function orderGroups<TGroup extends string>(
  present: Iterable<TGroup>,
  order: readonly TGroup[] = [],
): TGroup[] {
  const set = new Set<TGroup>(present);
  const ordered = order.filter((group) => set.has(group));
  const rest = [...set].filter((group) => !order.includes(group)).sort();
  return [...ordered, ...rest];
}
