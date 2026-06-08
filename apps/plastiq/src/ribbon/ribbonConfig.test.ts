import { describe, expect, it } from "vitest";
import { ACTIONS } from "../actions/registry.js";
import { RIBBON, RIBBON_ICONS, type RibbonItem } from "./ribbonConfig.js";

const KNOWN_WIDGETS = new Set(["sketchLauncher", "sectionControl", "simReadout", "viewControl"]);

function actionIds(items: RibbonItem[]): string[] {
  return items.filter((i) => i.kind === "action").map((i) => (i as { id: string }).id);
}

describe("ribbonConfig — integrity", () => {
  it("every referenced action id exists in the registry", () => {
    for (const tabs of Object.values(RIBBON)) {
      for (const tab of tabs) {
        for (const panel of tab.panels) {
          for (const id of actionIds(panel.items)) {
            expect(ACTIONS[id], `action "${id}" (tab ${tab.id})`).toBeDefined();
          }
        }
      }
    }
  });

  it("every referenced widget is a known widget", () => {
    for (const tabs of Object.values(RIBBON)) {
      for (const tab of tabs) {
        for (const panel of tab.panels) {
          for (const item of panel.items) {
            if (item.kind === "widget") expect(KNOWN_WIDGETS.has(item.widget)).toBe(true);
          }
        }
      }
    }
  });

  it("each workspace has at least one tab and each tab at least one panel", () => {
    for (const tabs of Object.values(RIBBON)) {
      expect(tabs.length).toBeGreaterThan(0);
      for (const tab of tabs) expect(tab.panels.length).toBeGreaterThan(0);
    }
  });

  it("the only contextual tab is design/sketch", () => {
    const contextual = Object.entries(RIBBON).flatMap(([ws, tabs]) =>
      tabs.filter((t) => t.contextual).map((t) => `${ws}/${t.id}:${t.contextual}`),
    );
    expect(contextual).toEqual(["design/sketch:sketch"]);
  });

  it("RIBBON_ICONS only keys real actions", () => {
    for (const id of Object.keys(RIBBON_ICONS)) expect(ACTIONS[id], id).toBeDefined();
  });

  it("no duplicate action id within a single panel", () => {
    for (const tabs of Object.values(RIBBON)) {
      for (const tab of tabs) {
        for (const panel of tab.panels) {
          const ids = actionIds(panel.items);
          expect(new Set(ids).size).toBe(ids.length);
        }
      }
    }
  });
});
