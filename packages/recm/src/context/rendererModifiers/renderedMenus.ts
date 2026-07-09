// Renderer modifier: normalize the rendered-menus facet — the menus/rings
// currently on screen. Dedupes by id (last wins) and sorts by depth ascending so
// consumers reading `context.renderedMenus` always see a stable, root-first list.
// Pure context → context.

import type {
  RecmContext,
  RecmContextModifier,
  RecmRenderedMenu,
} from "../../types.js";

/** Dedupe rendered menus by id (last wins) and sort by depth ascending. */
export function dedupeRenderedMenus(
  menus: readonly RecmRenderedMenu[],
): RecmRenderedMenu[] {
  const byId = new Map<string, RecmRenderedMenu>();
  for (const menu of menus) byId.set(menu.id, menu);
  return [...byId.values()].sort((a, b) => a.depth - b.depth);
}

/** The deepest rendered menu depth, or -1 when none are open. */
export function deepestRenderedMenu(menus: readonly RecmRenderedMenu[]): number {
  return menus.reduce((max, menu) => Math.max(max, menu.depth), -1);
}

export function renderedMenusModifier<TApp = unknown>(
  context: RecmContext<TApp>,
): RecmContext<TApp> {
  const deduped = dedupeRenderedMenus(context.renderedMenus);
  const same =
    deduped.length === context.renderedMenus.length &&
    deduped.every((menu, index) => menu === context.renderedMenus[index]);
  if (same) return context;
  return { ...context, renderedMenus: deduped };
}

/** Typed alias for uniform pipeline listing. */
export const renderedMenus: RecmContextModifier = renderedMenusModifier;
