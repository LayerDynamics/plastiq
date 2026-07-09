// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createRecmStore } from "../store.js";
import { useRecmConfig } from "./useConfig.js";
import { useRecmDepth } from "./useDepth.js";
import { useRecmOptions } from "./useOptions.js";
import { useRecmSelection } from "./useSelection.js";
import { useRecmRenderedObjects, useRegisterRecmObject } from "./useRenderedObject.js";
import { useRecmRenderedMenus, useRegisterRecmMenu } from "./useRenderedMenu.js";
import type { RecmContext } from "../types.js";

afterEach(cleanup);

function makeStore() {
  return createRecmStore<RecmContext, "create">({
    config: { groupOrder: ["create"] },
    providers: [() => [{ id: "box", group: "create", label: "Box" }]],
  });
}

const emptyCtx: RecmContext = {
  origin: { kind: "screen", x: 0, y: 0 },
  selection: [],
  renderedObjects: [],
  renderedMenus: [],
  activePath: [],
  depth: 0,
};

describe("recm hooks", () => {
  it("useRecmConfig reads the resolved config", () => {
    const store = makeStore();
    const { result } = renderHook(() => useRecmConfig(store));
    expect(result.current.maxDepth).toBe(3);
  });

  it("useRecmSelection reflects live selection + derived flags", () => {
    const store = makeStore();
    const { result } = renderHook(() => useRecmSelection(store));
    expect(result.current.hasSelection).toBe(false);
    act(() => store.getState().setSelection([{ id: "a", kind: "face" }]));
    expect(result.current.count).toBe(1);
    expect(result.current.hasSelection).toBe(true);
  });

  it("useRecmDepth tracks the active path against the cap", () => {
    const store = makeStore();
    const { result } = renderHook(() => useRecmDepth(store));
    expect(result.current.depth).toBe(0);
    act(() => store.getState().setActiveGroup("create"));
    expect(result.current.activePath).toEqual(["create"]);
    expect(result.current.depth).toBe(1);
    expect(result.current.maxDepth).toBe(3);
  });

  it("useRecmOptions exposes resolved sections + ids after opening", () => {
    const store = makeStore();
    const { result } = renderHook(() => useRecmOptions(store));
    expect(result.current.sections).toEqual([]);
    act(() => store.getState().openAt({ context: emptyCtx }));
    expect(result.current.itemIds).toEqual(["box"]);
    expect(result.current.activeGroup).toBe("create");
  });

  it("useRegisterRecmObject publishes for the component lifetime", () => {
    const store = makeStore();
    function Publisher(): null {
      useRegisterRecmObject(store, { id: "part", kind: "part", label: "Part" });
      return null;
    }
    const view = render(<Publisher />);
    expect(store.getState().renderedObjects.map((o) => o.id)).toEqual(["part"]);
    view.unmount();
    expect(store.getState().renderedObjects).toEqual([]);
  });

  it("useRegisterRecmMenu publishes a menu for the component lifetime", () => {
    const store = makeStore();
    function MenuPresence(): null {
      useRegisterRecmMenu(store, { id: "ring0", kind: "ring", depth: 0 });
      return null;
    }
    const view = render(<MenuPresence />);
    expect(store.getState().renderedMenus.map((m) => m.id)).toEqual(["ring0"]);
    view.unmount();
    expect(store.getState().renderedMenus).toEqual([]);
  });

  it("read hooks expose registry actions", () => {
    const store = makeStore();
    const objects = renderHook(() => useRecmRenderedObjects(store));
    act(() => objects.result.current.register({ id: "p", kind: "part" }));
    expect(objects.result.current.renderedObjects).toHaveLength(1);
    const menus = renderHook(() => useRecmRenderedMenus(store));
    act(() => menus.result.current.register({ id: "m", kind: "ring", depth: 0 }));
    expect(menus.result.current.renderedMenus).toHaveLength(1);
  });
});
