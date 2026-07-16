// Config-facing view of the theme defaults. Re-exports the canonical default
// theme plus the resolver so config builders can accept a preset name / partial
// override wherever a theme is expected — without a second copy of the tokens.

export { defaultRecmTheme } from "../config.js";
export { baseRecmTheme, RECM_COLOR_TOKENS, type RecmColorToken } from "../theme/base.js";
export { resolveRecmTheme, createRecmTheme, mergeRecmTheme } from "../theme/theme.js";
export { RECM_THEME_PRESETS, RECM_THEME_NAMES, isRecmThemeName } from "../theme/options.js";
