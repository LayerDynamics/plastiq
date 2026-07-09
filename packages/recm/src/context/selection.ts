// Selection queries over a RecmContext. Providers use these to decide which
// options are relevant ("something is selected", "exactly one face", "a mix of
// kinds"). Pure reads — no context mutation.

import type { RecmContext, RecmSelection } from "../types.js";

/** Dedupe a selection list by id, keeping the last occurrence (a re-pick of the
 *  same id updates its value), preserving first-seen order otherwise. */
export function normalizeSelection(
  selection: readonly RecmSelection[],
): RecmSelection[] {
  const byId = new Map<string, RecmSelection>();
  for (const entry of selection) byId.set(entry.id, entry);
  return [...byId.values()];
}

/** True when anything is selected. */
export function hasSelection(context: RecmContext): boolean {
  return context.selection.length > 0;
}

/** Number of selected entities. */
export function selectionCount(context: RecmContext): number {
  return context.selection.length;
}

/** True when more than one entity is selected. */
export function isMultiSelect(context: RecmContext): boolean {
  return context.selection.length > 1;
}

/** The first selected entity, or null. */
export function primarySelection(context: RecmContext): RecmSelection | null {
  return context.selection[0] ?? null;
}

/** The distinct selection kinds present, in first-seen order. */
export function selectionKinds(context: RecmContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of context.selection) {
    if (!seen.has(entry.kind)) {
      seen.add(entry.kind);
      out.push(entry.kind);
    }
  }
  return out;
}

/** Selected entities of a given kind. */
export function selectionByKind(context: RecmContext, kind: string): RecmSelection[] {
  return context.selection.filter((entry) => entry.kind === kind);
}

/** True when every selected entity shares one kind (a "homogeneous" selection). */
export function isHomogeneousSelection(context: RecmContext): boolean {
  return selectionKinds(context).length <= 1;
}
