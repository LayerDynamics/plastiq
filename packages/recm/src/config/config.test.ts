import { describe, expect, it } from "vitest";
import { mergeRecmConfig, loadRecmConfig } from "./config.js";
import { createRecmConfig } from "../config.js";
import { clampMaxDepth, clampDepth, isDepthVisible } from "./depth.js";
import {
  ringCenterRadius,
  ringInnerRadius,
  ringOuterRadius,
  ringStep,
  menuRadius,
  menuDiameter,
} from "./rings.js";
import { orderGroups } from "./options.js";
import { RECM_THEME_PRESETS } from "../theme/options.js";

describe("config/config", () => {
  it("merges an override, merging the theme per-token", () => {
    const base = createRecmConfig({ innerRadius: 10 });
    const next = mergeRecmConfig(base, { innerRadius: 20, theme: { text: "#fff" } });
    expect(next.innerRadius).toBe(20);
    expect(next.theme.text).toBe("#fff");
    expect(next.theme.panelBackground).toBe(base.theme.panelBackground); // untouched
  });

  it("loads a JSON config string, resolving a theme given by preset name", () => {
    const config = loadRecmConfig<string>('{"maxDepth":5,"theme":"light"}');
    expect(config.maxDepth).toBe(5);
    expect(config.theme).toEqual(RECM_THEME_PRESETS.light);
    // Unspecified fields fall back to createRecmConfig defaults.
    expect(config.innerRadius).toBe(createRecmConfig().innerRadius);
  });

  it("loads from an object and accepts a partial theme override", () => {
    const config = loadRecmConfig({ ringGap: 9, theme: { dangerText: "#f00" } });
    expect(config.ringGap).toBe(9);
    expect(config.theme.dangerText).toBe("#f00");
  });

  it("throws (never silently defaults) on malformed JSON", () => {
    expect(() => loadRecmConfig("{ not json")).toThrow();
  });
});

describe("config/depth", () => {
  it("clamps maxDepth into the supported range", () => {
    expect(clampMaxDepth(0)).toBe(1);
    expect(clampMaxDepth(999)).toBe(8);
    expect(clampMaxDepth(Number.NaN)).toBe(3);
    expect(clampMaxDepth(4)).toBe(4);
  });

  it("clamps a ring index to what the config renders", () => {
    const config = { maxDepth: 3 };
    expect(clampDepth(-2, config)).toBe(0);
    expect(clampDepth(5, config)).toBe(2);
    expect(clampDepth(1, config)).toBe(1);
    expect(isDepthVisible(2, config)).toBe(true);
    expect(isDepthVisible(3, config)).toBe(false);
  });
});

describe("config/rings geometry", () => {
  const config = createRecmConfig({
    centerSize: 40,
    innerRadius: 20,
    ringThickness: 40,
    ringGap: 10,
  });

  it("computes concentric ring radii and overall size", () => {
    expect(ringCenterRadius(config)).toBe(20); // max(12, 40/2)
    expect(ringStep(config)).toBe(50); // 40 + 10
    expect(ringInnerRadius(0, config)).toBe(40); // 20 + 20
    expect(ringInnerRadius(1, config)).toBe(90); // 40 + 50
    expect(ringOuterRadius(0, config)).toBe(80); // 40 + 40
    expect(menuRadius(2, config)).toBe(ringOuterRadius(1, config) + 8);
    expect(menuDiameter(2, config)).toBe(menuRadius(2, config) * 2);
  });
});

describe("config/options ordering", () => {
  it("lists preferred groups first, then unlisted groups sorted", () => {
    expect(orderGroups(["view", "create", "zeta", "alpha"], ["create", "modify", "view"])).toEqual([
      "create",
      "view",
      "alpha",
      "zeta",
    ]);
  });

  it("drops preferred groups that are absent", () => {
    expect(orderGroups(["view"], ["create", "modify", "view"])).toEqual(["view"]);
  });
});
