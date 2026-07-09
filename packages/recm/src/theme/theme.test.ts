import { describe, expect, it } from "vitest";
import { baseRecmTheme, RECM_COLOR_TOKENS } from "./base.js";
import { RECM_THEME_PRESETS, RECM_THEME_NAMES, isRecmThemeName } from "./options.js";
import { createRecmTheme, mergeRecmTheme, resolveRecmTheme } from "./theme.js";
import { withTheme } from "./config.js";
import { createRecmConfig } from "../config.js";

describe("recm theme", () => {
  it("exposes named presets that all define every colour token", () => {
    expect(RECM_THEME_NAMES).toContain("dark");
    for (const name of RECM_THEME_NAMES) {
      const theme = RECM_THEME_PRESETS[name];
      for (const token of RECM_COLOR_TOKENS) {
        expect(typeof theme[token]).toBe("string");
      }
    }
    expect(RECM_THEME_PRESETS.dark).toBe(baseRecmTheme);
  });

  it("guards preset names", () => {
    expect(isRecmThemeName("light")).toBe(true);
    expect(isRecmThemeName("nope")).toBe(false);
    expect(isRecmThemeName(42)).toBe(false);
  });

  it("resolves names, full themes, and partial overrides", () => {
    expect(resolveRecmTheme("light")).toEqual(RECM_THEME_PRESETS.light);
    expect(resolveRecmTheme("light")).not.toBe(RECM_THEME_PRESETS.light); // copied
    const partial = resolveRecmTheme({ dangerText: "#f00" });
    expect(partial.dangerText).toBe("#f00");
    expect(partial.text).toBe(baseRecmTheme.text); // base preserved
    const full = createRecmTheme({ text: "#abc" });
    expect(resolveRecmTheme(full)).toEqual(full);
  });

  it("layers a partial onto a chosen base", () => {
    const merged = mergeRecmTheme(RECM_THEME_PRESETS.light, { text: "#000" });
    expect(merged.text).toBe("#000");
    expect(merged.panelBackground).toBe(RECM_THEME_PRESETS.light.panelBackground);
    const onLight = resolveRecmTheme({ text: "#000" }, RECM_THEME_PRESETS.light);
    expect(onLight.panelBackground).toBe(RECM_THEME_PRESETS.light.panelBackground);
  });

  it("applies a theme onto a config without touching geometry", () => {
    const config = createRecmConfig({ innerRadius: 33 });
    const themed = withTheme(config, "blueprint");
    expect(themed.theme).toEqual(RECM_THEME_PRESETS.blueprint);
    expect(themed.innerRadius).toBe(33);
    const tweaked = withTheme(config, { dangerText: "#fff" });
    expect(tweaked.theme.dangerText).toBe("#fff");
    expect(tweaked.theme.text).toBe(config.theme.text);
  });
});
