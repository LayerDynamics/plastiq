// Renderer modifier: normalize the rendered-objects facet — the live scene
// inventory (parts, mesh bodies, assembly instances) the menu can act on.
// Dedupes by id (last registration wins) so a re-published object replaces its
// prior entry rather than duplicating. Pure context → context.

import type {
  RecmContext,
  RecmContextModifier,
  RecmRenderedObject,
} from "../../types.js";

/** Dedupe rendered objects by id, keeping the last occurrence. */
export function dedupeRenderedObjects(
  objects: readonly RecmRenderedObject[],
): RecmRenderedObject[] {
  const byId = new Map<string, RecmRenderedObject>();
  for (const object of objects) byId.set(object.id, object);
  return [...byId.values()];
}

export function renderedObjectsModifier<TApp = unknown>(
  context: RecmContext<TApp>,
): RecmContext<TApp> {
  const deduped = dedupeRenderedObjects(context.renderedObjects);
  if (deduped.length === context.renderedObjects.length) return context;
  return { ...context, renderedObjects: deduped };
}

/** Typed alias for uniform pipeline listing. */
export const renderedObjects: RecmContextModifier = renderedObjectsModifier;
