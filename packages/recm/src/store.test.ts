import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRecmStore } from "./store.js";

interface Ctx {
  selected: boolean;
}

describe("recm store", () => {
  const run = vi.fn();
  const useStore = createRecmStore<Ctx, "create" | "modify">({
    config: { groupOrder: ["create", "modify"] },
    providers: [
      (ctx) => [
        { id: "box", group: "create", label: "Box" },
        {
          id: "delete",
          group: "modify",
          label: "Delete",
          visible: () => ctx.selected,
        },
      ],
    ],
    runOption: run,
  });

  beforeEach(() => {
    run.mockClear();
    useStore.getState().close();
  });

  it("opens from dynamic providers and closes cleanly", () => {
    useStore.getState().openAt({
      context: { selected: true },
      anchor: { kind: "world", point: [1, 2, 3] },
    });
    expect(useStore.getState().open).toBe(true);
    expect(useStore.getState().sections.map((section) => section.group)).toEqual([
      "create",
      "modify",
    ]);

    useStore.getState().close();
    expect(useStore.getState().open).toBe(false);
    expect(useStore.getState().sections).toEqual([]);
  });

  it("tracks rendered object/menu registries and runs options against context", () => {
    useStore.getState().registerRenderedObject({ id: "part", kind: "mesh" });
    useStore.getState().registerRenderedMenu({ id: "root", kind: "ring", depth: 0 });
    expect(useStore.getState().renderedObjects).toHaveLength(1);
    expect(useStore.getState().renderedMenus).toHaveLength(1);

    useStore.getState().openAt({ context: { selected: true } });
    useStore.getState().runOption("delete");
    expect(run).toHaveBeenCalledWith("delete", { selected: true });
    expect(useStore.getState().open).toBe(false);
  });
});
