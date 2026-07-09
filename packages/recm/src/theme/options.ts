// Named theme presets. Each preset is a full RecmTheme so a consumer can select
// one by name (`resolveRecmTheme("light")`) without knowing the token set. The
// dark preset is the base default; the others are complete, self-consistent
// palettes (not partial tweaks) so switching presets never leaves stale tokens.

import { baseRecmTheme } from "./base.js";
import type { RecmTheme, RecmThemeName } from "../types.js";

const light: RecmTheme = {
  panelBackground: "#f7f9fc",
  panelBorder: "#cdd6e2",
  groupBackground: "#eef2f8",
  groupBackgroundActive: "#dbe6f6",
  itemBackground: "#ffffff",
  itemBackgroundHover: "#e6edf7",
  text: "#1b2430",
  dangerText: "#c0392b",
  disabledOpacity: 0.4,
  shadow: "0 10px 28px rgb(15 30 50 / 0.18)",
};

const highContrast: RecmTheme = {
  panelBackground: "#000000",
  panelBorder: "#ffffff",
  groupBackground: "#0a0a0a",
  groupBackgroundActive: "#ffd400",
  itemBackground: "#000000",
  itemBackgroundHover: "#1a1a1a",
  text: "#ffffff",
  dangerText: "#ff5252",
  disabledOpacity: 0.55,
  shadow: "0 0 0 2px #ffffff",
};

const blueprint: RecmTheme = {
  panelBackground: "#0b2038",
  panelBorder: "#2f6fb0",
  groupBackground: "#0f2c4d",
  groupBackgroundActive: "#1e5aa0",
  itemBackground: "#0b2440",
  itemBackgroundHover: "#144a86",
  text: "#cfe6ff",
  dangerText: "#ff9d8a",
  disabledOpacity: 0.42,
  shadow: "0 10px 30px rgb(0 20 45 / 0.55)",
};

/** All built-in presets, keyed by name. `dark` is the shared base default. */
export const RECM_THEME_PRESETS: Record<RecmThemeName, RecmTheme> = {
  dark: baseRecmTheme,
  light,
  highContrast,
  blueprint,
};

/** The ordered list of preset names (for pickers / cycling). */
export const RECM_THEME_NAMES = Object.keys(RECM_THEME_PRESETS) as RecmThemeName[];

/** Type guard: is `value` the name of a built-in preset? */
export function isRecmThemeName(value: unknown): value is RecmThemeName {
  return typeof value === "string" && value in RECM_THEME_PRESETS;
}
