// Base theme tokens for RECM. The canonical dark default lives in ../config.ts
// (`defaultRecmTheme`) and is re-exported here as `baseRecmTheme` so the theme
// subsystem has a single source of truth to layer presets/overrides on top of —
// there is intentionally no second copy of the token values.

import { defaultRecmTheme } from "../config.js";
import type { RecmTheme } from "../types.js";

/** The base theme every preset and override is merged onto (the dark default). */
export const baseRecmTheme: RecmTheme = defaultRecmTheme;

/** The token keys that carry a CSS colour, grouped for preset authoring and for
 *  contrast/validation passes. `disabledOpacity`/`shadow` are excluded — they
 *  are a number and a composite shadow string, not plain colours. */
export const RECM_COLOR_TOKENS = [
  "panelBackground",
  "panelBorder",
  "groupBackground",
  "groupBackgroundActive",
  "itemBackground",
  "itemBackgroundHover",
  "text",
  "dangerText",
] as const satisfies readonly (keyof RecmTheme)[];

export type RecmColorToken = (typeof RECM_COLOR_TOKENS)[number];
