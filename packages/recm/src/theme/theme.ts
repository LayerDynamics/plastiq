// Theme composition: resolve a RecmThemeInput (a preset name, a full theme, or a
// partial override) down to a concrete RecmTheme, and merge overrides onto a
// base. This is the one place tokens are combined so config + components agree.

import { baseRecmTheme } from "./base.js";
import { RECM_THEME_PRESETS, isRecmThemeName } from "./options.js";
import type { RecmTheme, RecmThemeInput } from "../types.js";

/** Merge a partial override onto a base theme (override wins per token). */
export function mergeRecmTheme(base: RecmTheme, overrides?: Partial<RecmTheme>): RecmTheme {
  return overrides ? { ...base, ...overrides } : { ...base };
}

/** Build a theme from partial overrides on the base dark default. */
export function createRecmTheme(overrides: Partial<RecmTheme> = {}): RecmTheme {
  return mergeRecmTheme(baseRecmTheme, overrides);
}

/** Distinguish a full theme from a partial override: a full theme carries every
 *  token key. Used so `resolveRecmTheme` can treat a complete object as-is but
 *  layer a partial one onto the base. */
function isFullTheme(value: RecmTheme | Partial<RecmTheme>): value is RecmTheme {
  return (
    "panelBackground" in value &&
    "text" in value &&
    "disabledOpacity" in value &&
    "shadow" in value
  );
}

/**
 * Resolve any accepted theme reference to a concrete RecmTheme:
 *   - a preset name → that preset,
 *   - a full theme object → itself (copied),
 *   - a partial override → merged onto the base dark default.
 * `base` overrides which theme a partial/name is layered on (defaults to dark).
 */
export function resolveRecmTheme(
  input: RecmThemeInput = "dark",
  base: RecmTheme = baseRecmTheme,
): RecmTheme {
  if (isRecmThemeName(input)) return { ...RECM_THEME_PRESETS[input] };
  if (isFullTheme(input)) return { ...input };
  return mergeRecmTheme(base, input);
}
