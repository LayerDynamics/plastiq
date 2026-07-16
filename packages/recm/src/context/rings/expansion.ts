// Ring expansion: turn a context + active path into the outward-growing ring
// tree, plus the pure path algebra that drives "reach outward" / "pull back".
// The heavy lifting (recursive provider resolution) lives in the flat engine's
// resolveRecmTree — this wraps it so the active path is applied consistently and
// the result is packaged as a RecmExpansion.

import { resolveRecmTree } from "../../options.js";
import type {
  RecmConfig,
  RecmContext,
  RecmExpansion,
  RecmOptionProvider,
} from "../../types.js";

/** Set the chosen option id at `depth`, discarding any deeper (now-stale) path
 *  entries. This is how hovering/selecting a ring segment updates the path. */
export function expandPath(
  activePath: readonly string[],
  depth: number,
  id: string,
): string[] {
  return [...activePath.slice(0, depth), id];
}

/** Collapse the path back to before `depth` (pull the menu inward). */
export function collapsePath(activePath: readonly string[], depth: number): string[] {
  return activePath.slice(0, Math.max(0, depth));
}

/** True when `id` is the active choice at `depth`. */
export function isPathActive(
  activePath: readonly string[],
  depth: number,
  id: string,
): boolean {
  return activePath[depth] === id;
}

/**
 * Expand the rings for `context` along `activePath`, capped by `config.maxDepth`.
 * The provided path overrides `context.activePath` so the same context can be
 * re-expanded along different branches without rebuilding it.
 */
export function expandRings<TApp = unknown, TGroup extends string = string>(
  context: RecmContext<TApp>,
  providers: readonly RecmOptionProvider<RecmContext<TApp>, TGroup>[],
  config: Pick<RecmConfig<TGroup>, "groupOrder" | "maxDepth">,
  activePath: readonly string[] = context.activePath,
): RecmExpansion<TApp, TGroup> {
  const tree = resolveRecmTree({ ...context, activePath }, providers, config);
  return { tree, activePath: tree.activePath, depth: tree.rings.length };
}
