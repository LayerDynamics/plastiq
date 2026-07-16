// Selection modifier: normalize the active-menu-path facet. Trims trailing empty
// path segments and re-derives `depth` from the cleaned path so `context.depth`
// always equals how many rings deep the current selection reaches. Pure.

import type { RecmContext, RecmContextModifier } from "../../types.js";

/** Drop trailing empty/blank segments and sync depth to the path length. */
export function selectedMenuModifier<TApp = unknown>(
  context: RecmContext<TApp>,
): RecmContext<TApp> {
  let end = context.activePath.length;
  while (end > 0 && !context.activePath[end - 1]) end -= 1;
  const trimmed = end === context.activePath.length
    ? context.activePath
    : context.activePath.slice(0, end);
  if (trimmed === context.activePath && context.depth === trimmed.length) return context;
  return { ...context, activePath: [...trimmed], depth: trimmed.length };
}

/** Typed alias for uniform pipeline listing. */
export const selectedMenu: RecmContextModifier = selectedMenuModifier;
