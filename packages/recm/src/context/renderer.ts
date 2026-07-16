// The renderer stage: run the modifier pipeline over a raw context, then expand
// it into rings. `defaultRecmModifiers` is the standard normalization order —
// rendered facets first (scene inventory), then selection facets (what the user
// pointed at), then the active-menu path. Consumers can supply their own list.

import { createRecmContext } from "./context.js";
import { renderedObjectsModifier } from "./rendererModifiers/renderedObjects.js";
import { renderedMenusModifier } from "./rendererModifiers/renderedMenus.js";
import { selectedObjectModifier } from "./selectionModifiers/selectedObject.js";
import { selectedMenuModifier } from "./selectionModifiers/selectedMenu.js";
import { expandRings } from "./rings/expansion.js";
import type {
  RecmConfig,
  RecmContext,
  RecmContextInput,
  RecmContextModifier,
  RecmExpansion,
  RecmOptionProvider,
} from "../types.js";

/** The standard pipeline: normalize scene facets, then selection, then path. */
export const defaultRecmModifiers: readonly RecmContextModifier[] = [
  renderedObjectsModifier,
  renderedMenusModifier,
  selectedObjectModifier,
  selectedMenuModifier,
];

/** Fold a list of modifiers over a context. Modifiers only normalize the
 *  selection/rendered/path facets and never touch `app`, so the TApp binding is
 *  preserved across the fold. */
export function runModifiers<TApp = unknown>(
  context: RecmContext<TApp>,
  modifiers: readonly RecmContextModifier[] = defaultRecmModifiers,
): RecmContext<TApp> {
  return modifiers.reduce<RecmContext<TApp>>(
    (acc, modify) => modify(acc) as RecmContext<TApp>,
    context,
  );
}

/**
 * Build a render-ready context and its ring tree from raw inputs in one call:
 * create → run modifiers → expand. Returns both the refined context and the
 * expansion so a renderer can draw rings and re-run providers consistently.
 */
export function deriveRenderContext<TApp = unknown, TGroup extends string = string>(
  input: RecmContextInput<TApp>,
  providers: readonly RecmOptionProvider<RecmContext<TApp>, TGroup>[],
  config: Pick<RecmConfig<TGroup>, "groupOrder" | "maxDepth">,
  modifiers: readonly RecmContextModifier[] = defaultRecmModifiers,
): { context: RecmContext<TApp>; expansion: RecmExpansion<TApp, TGroup> } {
  const context = runModifiers(createRecmContext(input), modifiers);
  const expansion = expandRings(context, providers, config, context.activePath);
  return { context, expansion };
}
