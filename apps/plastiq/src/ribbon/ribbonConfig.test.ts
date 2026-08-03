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

  it("the design workspace exposes the Mesh → CAD conversions (reconstruct / fit-NURBS)", () => {
    const solid = RIBBON.design.find((t) => t.id === "solid")!;
    const meshPanel = solid.panels.find((p) => p.title === "Mesh → CAD")!;
    expect(meshPanel, "design/solid must have a Mesh → CAD panel").toBeDefined();
    expect(actionIds(meshPanel.items)).toEqual(["ml-reconstruct-brep", "ml-fit-nurbs"]);
  });

  it("the design workspace exposes the point-cloud hand-offs (to-mesh / complete)", () => {
    const solid = RIBBON.design.find((t) => t.id === "solid")!;
    const cloudPanel = solid.panels.find((p) => p.title === "Point Cloud")!;
    expect(cloudPanel, "design/solid must have a Point Cloud panel").toBeDefined();
    expect(actionIds(cloudPanel.items)).toEqual(["cloud-to-mesh", "cloud-complete"]);
  });

  it("the design workspace has a Surface tab with create + modify surface ops (§14)", () => {
    const surface = RIBBON.design.find((t) => t.id === "surface")!;
    expect(surface, "design must have a Surface tab").toBeDefined();
    expect(surface.title).toBe("Surface");
    const create = surface.panels.find((p) => p.title === "Create")!;
    const modify = surface.panels.find((p) => p.title === "Modify")!;
    expect(actionIds(create.items)).toEqual([
      "surfaceLoft",
      "surfaceSweep",
      "surfaceRevolve",
    ]);
    expect(actionIds(modify.items)).toEqual([
      "offsetSurface",
      "sew",
      "solidify",
      "patch",
      "trim",
      "thicken",
    ]);
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
