// Config composition entry point. Re-exports the canonical `createRecmConfig`
// and adds two things the granular design needs: a shallow `mergeRecmConfig`
// (config + override → config, theme merged token-wise) and `loadRecmConfig`,
// which turns the README's `configuration('configFile.json')` into a real,
// validated config — including a `theme` field given as a preset name.

import { createRecmConfig } from "../config.js";
import { resolveRecmTheme } from "../theme/theme.js";
import type { RecmConfig, RecmTheme, RecmThemeInput } from "../types.js";

export { createRecmConfig, defaultRecmTheme, DEFAULT_GROUP_ORDER } from "../config.js";

/** The JSON-friendly shape a config file may take: any RecmConfig field, with
 *  `theme` allowed as a preset name / partial override rather than a full theme. */
export type RecmConfigFile<TGroup extends string = string> = Omit<
  Partial<RecmConfig<TGroup>>,
  "theme"
> & { theme?: RecmThemeInput };

/** Merge an override onto a base config; the theme is merged per-token so a
 *  partial theme override does not wipe the base theme's other tokens. */
export function mergeRecmConfig<TGroup extends string = string>(
  base: RecmConfig<TGroup>,
  override: Omit<Partial<RecmConfig<TGroup>>, "theme"> & { theme?: Partial<RecmTheme> } = {},
): RecmConfig<TGroup> {
  return {
    ...base,
    ...override,
    theme: override.theme ? { ...base.theme, ...override.theme } : base.theme,
  };
}

/**
 * Load a config from a JSON string or an already-parsed config file object,
 * resolving a `theme` given as a preset name / partial override into concrete
 * tokens, then filling every remaining field from createRecmConfig's defaults.
 * Throws on malformed JSON (never silently swallows) so a broken config file is
 * a loud failure, not a silent fallback to defaults.
 */
export function loadRecmConfig<TGroup extends string = string>(
  source: string | RecmConfigFile<TGroup>,
): RecmConfig<TGroup> {
  const file: RecmConfigFile<TGroup> =
    typeof source === "string" ? (JSON.parse(source) as RecmConfigFile<TGroup>) : source;
  const { theme, ...rest } = file;
  return createRecmConfig<TGroup>({
    ...rest,
    ...(theme !== undefined ? { theme: resolveRecmTheme(theme) } : {}),
  });
}
