// The manager: a framework-agnostic orchestrator that ties the modifier
// pipeline, ring expansion, and option execution into one object. It holds no
// React/DOM state — the store, hooks, and listener drive it — so it is fully
// unit-testable in Node. This is the seam a host app plugs its config +
// providers into (the README's `<RECM configuration options context .../>`).

import { createRecmContext, extendRecmContext } from "./context.js";
import { defaultRecmModifiers, runModifiers } from "./renderer.js";
import { expandRings, expandPath } from "./rings/expansion.js";
import { findOption } from "./rings/options.js";
import { resolveRecmSections } from "../options.js";
import type {
  RecmConfig,
  RecmContext,
  RecmContextInput,
  RecmContextModifier,
  RecmExpansion,
  RecmManager,
  RecmMenuSection,
  RecmOptionProvider,
} from "../types.js";

export interface CreateRecmManagerInput<TApp = unknown, TGroup extends string = string> {
  config: RecmConfig<TGroup>;
  providers: readonly RecmOptionProvider<RecmContext<TApp>, TGroup>[];
  /** Override the default normalization pipeline. */
  modifiers?: readonly RecmContextModifier[];
  /** Called (in addition to an option's own `run`) when a terminal option runs.
   *  Lets a host route all executions through one dispatcher (e.g. an action id
   *  → command map). */
  runOption?: (id: string, context: RecmContext<TApp>) => void;
}

/** Construct a manager bound to a config + provider set. */
export function createRecmManager<TApp = unknown, TGroup extends string = string>({
  config,
  providers,
  modifiers = defaultRecmModifiers,
  runOption,
}: CreateRecmManagerInput<TApp, TGroup>): RecmManager<TApp, TGroup> {
  const buildContext = (input: RecmContextInput<TApp>): RecmContext<TApp> =>
    runModifiers(createRecmContext(input), modifiers);

  const expand = (
    context: RecmContext<TApp>,
    activePath: readonly string[],
  ): RecmExpansion<TApp, TGroup> => expandRings(context, providers, config, activePath);

  const sections = (context: RecmContext<TApp>): RecmMenuSection<TGroup>[] =>
    resolveRecmSections(context, providers, config);

  const run = (
    context: RecmContext<TApp>,
    activePath: readonly string[],
    id: string,
  ): boolean => {
    const { tree } = expand(context, activePath);
    const found = findOption(tree, id);
    // Only terminal, enabled options execute. A group/parent id is an expand
    // gesture, not a run — the renderer handles that by growing the path.
    if (!found || found.option.hasChildren || !found.option.enabled) return false;
    const ctxAtDepth = extendRecmContext(context, {
      activePath: expandPath(activePath, found.depth, id),
      depth: found.depth,
    });
    found.option.option.run?.(ctxAtDepth);
    runOption?.(id, ctxAtDepth);
    return true;
  };

  return { config, providers, buildContext, expand, sections, run };
}
