// Read the resolved RecmConfig from a RECM store. Thin selector hook so a host
// component can size/theme itself off the same config the menu renders with.

import type { RecmConfig } from "../types.js";
import type { RecmStore } from "../store.js";

export function useRecmConfig<TContext, TGroup extends string = string>(
  store: RecmStore<TContext, TGroup>,
): RecmConfig<TGroup> {
  return store((state) => state.config);
}
