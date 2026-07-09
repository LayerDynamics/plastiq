// Selection modifier: normalize the selection facet of a context. Dedupes picks
// by id (a re-pick updates its value rather than appearing twice) so downstream
// providers see each selected entity exactly once. Pure context → context.

import { normalizeSelection } from "../selection.js";
import type { RecmContext, RecmContextModifier } from "../../types.js";

/** Collapse duplicate selections by id. */
export function selectedObjectModifier<TApp = unknown>(
  context: RecmContext<TApp>,
): RecmContext<TApp> {
  const normalized = normalizeSelection(context.selection);
  if (normalized.length === context.selection.length) return context;
  return { ...context, selection: normalized };
}

/** Typed alias so the pipeline can list modifiers uniformly. */
export const selectedObject: RecmContextModifier = selectedObjectModifier;
