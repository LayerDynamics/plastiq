// The composed RECM store. The single store state is assembled from focused
// slices under ./stores (config, selection, rendered objects, rendered menus,
// resolved options, ring navigation, and the open/close context lifecycle). The
// slices are the separation-of-concerns home for each field/action; this file is
// the composition root that wires them into one zustand store with the same
// public shape createRecmStore has always exposed.

import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createRecmConfig } from "./config.js";
import { createConfigSlice } from "./stores/configStore.js";
import { createSelectionSlice } from "./stores/selectionStore.js";
import { createObjectSlice } from "./stores/objectStore.js";
import { createMenuSlice } from "./stores/menuStore.js";
import { createOptionSlice } from "./stores/optionStore.js";
import { createRingSlice } from "./stores/ringStore.js";
import { createContextSlice } from "./stores/contextStore.js";
import type { RecmConfigSlice } from "./stores/configStore.js";
import type { RecmSelectionSlice } from "./stores/selectionStore.js";
import type { RecmObjectSlice } from "./stores/objectStore.js";
import type { RecmMenuSlice } from "./stores/menuStore.js";
import type { RecmOptionSlice } from "./stores/optionStore.js";
import type { RecmRingSlice } from "./stores/ringStore.js";
import type { RecmContextSlice } from "./stores/contextStore.js";
import type { RecmConfig, RecmOptionProvider } from "./types.js";

/** The full store state: the union of every slice's fields + actions. Kept as an
 *  interface (not a mapped intersection) so the public type reads cleanly and is
 *  stable for consumers importing it. */
export interface RecmStoreState<TContext, TGroup extends string = string>
  extends RecmConfigSlice<TGroup>,
    RecmSelectionSlice,
    RecmObjectSlice,
    RecmMenuSlice,
    RecmOptionSlice<TGroup>,
    RecmRingSlice<TGroup>,
    RecmContextSlice<TContext, TGroup> {}

/** The bound hook a `createRecmStore` call returns — the type hooks/ consume. */
export type RecmStore<TContext, TGroup extends string = string> = UseBoundStore<
  StoreApi<RecmStoreState<TContext, TGroup>>
>;

export function createRecmStore<TContext, TGroup extends string = string>({
  config,
  providers = [],
  runOption,
}: {
  config?: Partial<RecmConfig<TGroup>>;
  providers?: readonly RecmOptionProvider<TContext, TGroup>[];
  runOption?: (id: string, context: TContext) => void;
} = {}): UseBoundStore<StoreApi<RecmStoreState<TContext, TGroup>>> {
  const resolvedConfig = createRecmConfig<TGroup>(config);
  return create<RecmStoreState<TContext, TGroup>>((set, get) => ({
    ...createConfigSlice<TGroup>(resolvedConfig),
    ...createSelectionSlice<TContext, TGroup>(set),
    ...createObjectSlice<TContext, TGroup>(set),
    ...createMenuSlice<TContext, TGroup>(set),
    ...createOptionSlice<TGroup>(),
    ...createRingSlice<TContext, TGroup>(set),
    ...createContextSlice<TContext, TGroup>(set, get, {
      config: resolvedConfig,
      providers,
      ...(runOption !== undefined ? { runOption } : {}),
    }),
  }));
}
