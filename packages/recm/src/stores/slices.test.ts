import { describe, expect, it } from "vitest";
import { createRecmStore } from "../store.js";
import { optionIds } from "./optionStore.js";
import type { RecmContext } from "../types.js";

const emptyCtx: RecmContext = {
  origin: { kind: "screen", x: 0, y: 0 },
  selection: [],
  renderedObjects: [],
  renderedMenus: [],
  activePath: [],
  depth: 0,
};

describe("store slice composition", () => {
  it("exposes every slice's fields + actions on the composed store", () => {
    const store = createRecmStore<RecmContext, "create" | "modify">({
      config: { groupOrder: ["create", "modify"] },
      providers: [
        () => [
          { id: "box", group: "create", label: "Box" },
          { id: "trim", group: "modify", label: "Trim" },
        ],
      ],
    });
    const state = store.getState();
    // config slice
    expect(state.config.maxDepth).toBe(3);
    // ring slice
    state.setActiveGroup("modify");
    expect(store.getState().activePath).toEqual(["modify"]);
    // option slice helper reads sections after openAt
    state.openAt({ context: emptyCtx });
    expect(optionIds(store.getState())).toEqual(["box", "trim"]);
    // object + menu slices
    state.registerRenderedObject({ id: "o", kind: "part" });
    state.registerRenderedMenu({ id: "m", kind: "ring", depth: 0 });
    expect(store.getState().renderedObjects).toHaveLength(1);
    expect(store.getState().renderedMenus).toHaveLength(1);
    state.unregisterRenderedObject("o");
    state.unregisterRenderedMenu("m");
    expect(store.getState().renderedObjects).toHaveLength(0);
    expect(store.getState().renderedMenus).toHaveLength(0);
  });
});
