// The RecmContext builder + immutable transforms. A RecmContext is the single
// object every option provider reads from ("what was right-clicked, what is on
// screen, how deep are we"). Everything here is pure and returns a fresh context
// so the modifier pipeline (context/manager.ts) stays replayable.

import type { RecmContext, RecmContextInput } from "../types.js";

/** Build a fully-populated context from raw inputs, defaulting every optional
 *  collection to an empty array and depth to 0. Arrays are copied so the built
 *  context never aliases caller-owned state. */
export function createRecmContext<TApp = unknown>(
  input: RecmContextInput<TApp>,
): RecmContext<TApp> {
  return {
    origin: input.origin,
    selection: input.selection ? [...input.selection] : [],
    renderedObjects: input.renderedObjects ? [...input.renderedObjects] : [],
    renderedMenus: input.renderedMenus ? [...input.renderedMenus] : [],
    activePath: input.activePath ? [...input.activePath] : [],
    depth: input.depth ?? 0,
    ...(input.app !== undefined ? { app: input.app } : {}),
  };
}

/** Shallow-patch a context, returning a new object (never mutates the input). */
export function extendRecmContext<TApp = unknown>(
  context: RecmContext<TApp>,
  patch: Partial<RecmContext<TApp>>,
): RecmContext<TApp> {
  return { ...context, ...patch };
}

/** Set the active path and derive `depth` from it (depth = how many rings deep
 *  the selection currently reaches). */
export function withActivePath<TApp = unknown>(
  context: RecmContext<TApp>,
  activePath: readonly string[],
): RecmContext<TApp> {
  return { ...context, activePath: [...activePath], depth: activePath.length };
}
