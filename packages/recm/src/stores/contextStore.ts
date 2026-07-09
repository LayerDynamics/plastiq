// Context slice: the orchestrating open/close lifecycle. `openAt` resolves the
// menu sections for a context (via the store's providers + config), seeds the
// root ring, and opens the menu only when there's something to show; `close`
// tears the whole transient state back down; `runOption` dispatches a chosen
// option against the live context, then closes. This slice owns the
// cross-cutting writes (sections + ring state live in sibling slices but are one
// composed store), so the providers/config/dispatch dependency lives here.

import type { StoreApi } from "zustand";
import { resolveRecmSections } from "../options.js";
import type {
  RecmAnchor,
  RecmConfig,
  RecmMenuSection,
  RecmOptionProvider,
} from "../types.js";
import type { RecmStoreState } from "../store.js";

type Store<TContext, TGroup extends string> = StoreApi<RecmStoreState<TContext, TGroup>>;

export interface RecmContextSliceDeps<TContext, TGroup extends string = string> {
  config: RecmConfig<TGroup>;
  providers: readonly RecmOptionProvider<TContext, TGroup>[];
  /** Host dispatch invoked with the chosen id + live context when an option runs. */
  runOption?: (id: string, context: TContext) => void;
}

export interface RecmContextSlice<TContext, TGroup extends string = string> {
  open: boolean;
  anchor: RecmAnchor | null;
  context: TContext | null;
  openAt: (input: {
    context: TContext;
    anchor?: RecmAnchor;
    sections?: RecmMenuSection<TGroup>[];
    providers?: readonly RecmOptionProvider<TContext, TGroup>[];
  }) => void;
  close: () => void;
  runOption: (id: string) => void;
}

export function createContextSlice<TContext, TGroup extends string = string>(
  set: Store<TContext, TGroup>["setState"],
  get: Store<TContext, TGroup>["getState"],
  deps: RecmContextSliceDeps<TContext, TGroup>,
): RecmContextSlice<TContext, TGroup> {
  return {
    open: false,
    anchor: null,
    context: null,
    openAt: ({ context, anchor, sections, providers: nextProviders }) => {
      const resolvedSections =
        sections ?? resolveRecmSections(context, nextProviders ?? deps.providers, deps.config);
      set({
        open: resolvedSections.length > 0,
        anchor: anchor ?? null,
        context,
        sections: resolvedSections,
        activeGroup: resolvedSections[0]?.group ?? null,
        activePath: [],
      });
    },
    close: () =>
      set({
        open: false,
        anchor: null,
        context: null,
        sections: [],
        activeGroup: null,
        activePath: [],
      }),
    runOption: (id) => {
      const { context } = get();
      if (context) deps.runOption?.(id, context);
      get().close();
    },
  };
}
