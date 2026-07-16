import { describe, expect, it } from "vitest";
import { buildRecmSections, resolveRecmOptions, recmItemIds, resolveRecmTree } from "./options.js";
import type { RecmContext, RecmOptionProvider } from "./types.js";

interface Ctx {
  selected: boolean;
}

const provider: RecmOptionProvider<Ctx, "create" | "modify"> = (ctx) => [
  {
    id: "box",
    group: "create",
    label: "Box",
  },
  {
    id: "delete",
    group: "modify",
    label: () => "Delete",
    danger: true,
    visible: () => ctx.selected,
    enabled: () => ctx.selected,
  },
];

const treeProvider: RecmOptionProvider<RecmContext<{ mode: string }>, "create" | "modify"> = (
  ctx,
) => [
  {
    id: "create",
    group: "create",
    label: "Create",
    children: (childCtx) => [
      {
        id: childCtx.app?.mode === "edit" ? "box" : "line",
        group: "create",
        label: "Child",
      },
    ],
  },
  {
    id: "modify",
    group: "modify",
    label: "Modify",
    visible: () => ctx.selection.length > 0,
  },
];

describe("recm options", () => {
  it("derives visible options from providers", () => {
    expect(resolveRecmOptions({ selected: false }, [provider]).map((item) => item.id)).toEqual([
      "box",
    ]);
    expect(resolveRecmOptions({ selected: true }, [provider]).map((item) => item.id)).toEqual([
      "box",
      "delete",
    ]);
  });

  it("builds ordered sections with resolved labels and state", () => {
    const options = resolveRecmOptions({ selected: true }, [provider]);
    const sections = buildRecmSections({ selected: true }, options, ["modify", "create"]);
    expect(sections.map((section) => section.group)).toEqual(["modify", "create"]);
    expect(sections[0]?.items[0]).toMatchObject({
      id: "delete",
      label: "Delete",
      danger: true,
      enabled: true,
    });
    expect(recmItemIds(sections)).toEqual(["delete", "box"]);
  });

  it("resolves recursive rings from context, children, and active path", () => {
    const context: RecmContext<{ mode: string }> = {
      origin: { kind: "screen", x: 0, y: 0 },
      selection: [{ id: "sel", kind: "face" }],
      renderedObjects: [{ id: "part", kind: "mesh" }],
      renderedMenus: [{ id: "menu", kind: "ring", depth: 0 }],
      activePath: [],
      depth: 0,
      app: { mode: "edit" },
    };
    const tree = resolveRecmTree(context, [treeProvider], {
      groupOrder: ["create", "modify"],
      maxDepth: 3,
    });
    expect(tree.rings).toHaveLength(2);
    expect(tree.rings[0]?.options.map((item) => item.id)).toEqual(["create", "modify"]);
    expect(tree.rings[1]?.options.map((item) => item.id)).toEqual(["box"]);
  });
});
