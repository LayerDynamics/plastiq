import { describe, expect, it } from "vitest";
import { createRecmContext, extendRecmContext, withActivePath } from "./context.js";
import {
  hasSelection,
  isHomogeneousSelection,
  isMultiSelect,
  normalizeSelection,
  primarySelection,
  selectionByKind,
  selectionCount,
  selectionKinds,
} from "./selection.js";
import { selectedObjectModifier } from "./selectionModifiers/selectedObject.js";
import { selectedMenuModifier } from "./selectionModifiers/selectedMenu.js";
import {
  dedupeRenderedObjects,
  renderedObjectsModifier,
} from "./rendererModifiers/renderedObjects.js";
import {
  deepestRenderedMenu,
  dedupeRenderedMenus,
  renderedMenusModifier,
} from "./rendererModifiers/renderedMenus.js";
import { defaultRecmModifiers, deriveRenderContext, runModifiers } from "./renderer.js";
import type { RecmContext, RecmOptionProvider } from "../types.js";

function ctx(over: Partial<RecmContext> = {}): RecmContext {
  return {
    origin: { kind: "screen", x: 0, y: 0 },
    selection: [],
    renderedObjects: [],
    renderedMenus: [],
    activePath: [],
    depth: 0,
    ...over,
  };
}

describe("context builder", () => {
  it("fills defaults and copies collections", () => {
    const selection = [{ id: "a", kind: "face" }];
    const built = createRecmContext({ origin: { kind: "screen", x: 1, y: 2 }, selection });
    expect(built.selection).toEqual(selection);
    expect(built.selection).not.toBe(selection);
    expect(built.renderedObjects).toEqual([]);
    expect(built.depth).toBe(0);
    expect("app" in built).toBe(false);
  });

  it("extends immutably and derives depth from the active path", () => {
    const base = ctx();
    expect(extendRecmContext(base, { depth: 3 })).not.toBe(base);
    const walked = withActivePath(base, ["create", "box"]);
    expect(walked.activePath).toEqual(["create", "box"]);
    expect(walked.depth).toBe(2);
  });
});

describe("selection queries", () => {
  const selection = [
    { id: "f1", kind: "face" },
    { id: "f2", kind: "face" },
    { id: "e1", kind: "edge" },
  ];
  const c = ctx({ selection });

  it("answers count / multi / primary / kinds", () => {
    expect(hasSelection(c)).toBe(true);
    expect(selectionCount(c)).toBe(3);
    expect(isMultiSelect(c)).toBe(true);
    expect(primarySelection(c)?.id).toBe("f1");
    expect(selectionKinds(c)).toEqual(["face", "edge"]);
    expect(selectionByKind(c, "face")).toHaveLength(2);
    expect(isHomogeneousSelection(c)).toBe(false);
    expect(isHomogeneousSelection(ctx({ selection: [{ id: "f1", kind: "face" }] }))).toBe(true);
    expect(primarySelection(ctx())).toBeNull();
  });

  it("normalizes duplicate ids keeping the last value", () => {
    const normalized = normalizeSelection([
      { id: "a", kind: "face", value: 1 },
      { id: "a", kind: "face", value: 2 },
      { id: "b", kind: "edge" },
    ]);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.value).toBe(2);
  });
});

describe("context modifiers", () => {
  it("selectedObjectModifier dedupes selection by id", () => {
    const out = selectedObjectModifier(
      ctx({ selection: [{ id: "a", kind: "x" }, { id: "a", kind: "x" }] }),
    );
    expect(out.selection).toHaveLength(1);
  });

  it("selectedObjectModifier returns the same ref when nothing changes", () => {
    const c = ctx({ selection: [{ id: "a", kind: "x" }] });
    expect(selectedObjectModifier(c)).toBe(c);
  });

  it("selectedMenuModifier trims trailing empties and syncs depth", () => {
    const out = selectedMenuModifier(ctx({ activePath: ["create", "", ""], depth: 3 }));
    expect(out.activePath).toEqual(["create"]);
    expect(out.depth).toBe(1);
  });

  it("renderedObjectsModifier dedupes by id (last wins)", () => {
    expect(
      dedupeRenderedObjects([
        { id: "p", kind: "part", label: "old" },
        { id: "p", kind: "part", label: "new" },
      ]),
    ).toEqual([{ id: "p", kind: "part", label: "new" }]);
    const out = renderedObjectsModifier(
      ctx({ renderedObjects: [{ id: "p", kind: "part" }, { id: "p", kind: "part" }] }),
    );
    expect(out.renderedObjects).toHaveLength(1);
  });

  it("renderedMenusModifier dedupes + sorts by depth and reports the deepest", () => {
    const menus = [
      { id: "b", kind: "ring", depth: 2 },
      { id: "a", kind: "ring", depth: 0 },
    ];
    expect(dedupeRenderedMenus(menus).map((m) => m.id)).toEqual(["a", "b"]);
    expect(deepestRenderedMenu(menus)).toBe(2);
    expect(deepestRenderedMenu([])).toBe(-1);
    const out = renderedMenusModifier(ctx({ renderedMenus: menus }));
    expect(out.renderedMenus.map((m) => m.depth)).toEqual([0, 2]);
  });
});

describe("renderer pipeline", () => {
  const providers: readonly RecmOptionProvider<RecmContext, "create">[] = [
    () => [{ id: "create", group: "create", label: "Create" }],
  ];

  it("runModifiers folds the default pipeline (normalizing all facets)", () => {
    const messy = ctx({
      selection: [{ id: "a", kind: "x" }, { id: "a", kind: "x" }],
      renderedObjects: [{ id: "p", kind: "part" }, { id: "p", kind: "part" }],
      activePath: ["create", ""],
      depth: 2,
    });
    const clean = runModifiers(messy, defaultRecmModifiers);
    expect(clean.selection).toHaveLength(1);
    expect(clean.renderedObjects).toHaveLength(1);
    expect(clean.activePath).toEqual(["create"]);
    expect(clean.depth).toBe(1);
  });

  it("deriveRenderContext builds a refined context and expands rings", () => {
    const { context, expansion } = deriveRenderContext(
      { origin: { kind: "screen", x: 0, y: 0 }, selection: [{ id: "a", kind: "x" }] },
      providers,
      { groupOrder: ["create"], maxDepth: 3 },
    );
    expect(context.selection).toHaveLength(1);
    expect(expansion.tree.rings[0]?.options.map((o) => o.id)).toEqual(["create"]);
    expect(expansion.depth).toBe(1);
  });
});
