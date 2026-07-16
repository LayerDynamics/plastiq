// Options slice: the resolved menu sections for the currently-open context. The
// sections are (re)computed by the context slice's `openAt` (which owns the
// providers + config); this slice holds them and exposes the flattened item-id
// list a host can use for keyboard registration / analytics.

import type { RecmMenuSection } from "../types.js";
import { recmItemIds } from "../options.js";

export interface RecmOptionSlice<TGroup extends string = string> {
  sections: RecmMenuSection<TGroup>[];
}

export function createOptionSlice<TGroup extends string = string>(): RecmOptionSlice<TGroup> {
  return { sections: [] };
}

/** Flatten a slice's sections into ordered option ids (root ring). */
export function optionIds<TGroup extends string = string>(
  slice: RecmOptionSlice<TGroup>,
): string[] {
  return recmItemIds(slice.sections);
}
