// Bridge between the theme subsystem and RecmConfig: apply a theme (by name,
// full theme, or partial override) onto an existing config without disturbing
// its geometry/depth fields. Keeps theming orthogonal to layout.

import { resolveRecmTheme } from "./theme.js";
import type { RecmConfig, RecmThemeInput } from "../types.js";

/** Return a copy of `config` with its `theme` replaced by the resolved theme.
 *  A partial override is layered onto the config's current theme, so callers can
 *  tweak a single token (`withTheme(cfg, { dangerText: "#f00" })`). */
export function withTheme<TGroup extends string = string>(
  config: RecmConfig<TGroup>,
  theme: RecmThemeInput,
): RecmConfig<TGroup> {
  return { ...config, theme: resolveRecmTheme(theme, config.theme) };
}
