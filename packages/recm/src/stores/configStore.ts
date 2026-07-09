// Config slice: holds the resolved, immutable RecmConfig the menu renders with.
// Static for the lifetime of the store (geometry/theme/depth are fixed at
// creation); a host that needs live re-theming rebuilds the store or drives the
// component's own settings panel.

import type { RecmConfig } from "../types.js";

export interface RecmConfigSlice<TGroup extends string = string> {
  config: RecmConfig<TGroup>;
}

export function createConfigSlice<TGroup extends string = string>(
  config: RecmConfig<TGroup>,
): RecmConfigSlice<TGroup> {
  return { config };
}
