import { describe, expect, it } from "vitest";
import { collapsePath, expandPath, expandRings, isPathActive } from "./rings/expansion.js";
import { activeOption, findOption, ringOptions, terminalOption } from "./rings/options.js";
import { canExpand, resolvedDepth } from "./rings/depth.js";
import { ringAtDepth, ringsToSections, rootRing } from "./rings/rings.js";
import { createRecmConfig } from "../config.js";
import type { RecmContext, RecmOptionProvider } from "../types.js";

const providers: readonly RecmOptionProvider<RecmContext, "create" | "modify">[] = [
  () => [
    {
      id: "create",
      group: "create",
      label: "Create",
      children: () => [
        { id: "box", group: "create", label: "Box" },
        { id: "sphere", group: "create", label: "Sphere" },
      ],
    },
    { id: "inspect", group: "modify", label: "Inspect" },
  ],
];

function baseCtx(activePath: string[] = []): RecmContext {
  return {
    origin: { kind: "screen", x: 0, y: 0 },
    selection: [],
    renderedObjects: [],
    renderedMenus: [],
    activePath,
    depth: activePath.length,
  };
}

const config = createRecmConfig<"create" | "modify">({ groupOrder: ["create", "modify"], maxDepth: 3 });

describe("ring path algebra", () => {
  it("expands, collapses, and tests the active path", () => {
    expect(expandPath(["create", "box"], 1, "sphere")).toEqual(["create", "sphere"]);
    expect(expandPath(["create", "box"], 0, "inspect")).toEqual(["inspect"]);
    expect(collapsePath(["a", "b", "c"], 1)).toEqual(["a"]);
    expect(collapsePath(["a"], -3)).toEqual([]);
    expect(isPathActive(["create", "box"], 1, "box")).toBe(true);
    expect(isPathActive(["create", "box"], 1, "sphere")).toBe(false);
  });
});

describe("ring expansion + queries", () => {
  it("expands rings along the active path", () => {
    const expansion = expandRings(baseCtx(), providers, config, ["create"]);
    expect(expansion.depth).toBe(2);
    expect(ringOptions(expansion.tree, 1).map((o) => o.id)).toEqual(["box", "sphere"]);
  });

  it("finds active / terminal / by-id options", () => {
    const { tree } = expandRings(baseCtx(["create", "box"]), providers, config, ["create", "box"]);
    const root = ringAtDepth(tree, 0);
    expect(root && activeOption(root)?.id).toBe("create");
    expect(findOption(tree, "sphere")?.depth).toBe(1);
    expect(findOption(tree, "ghost")).toBeNull();
    // "box" is a leaf → it is the terminal option once the path points at it.
    expect(terminalOption(tree)?.id).toBe("box");
  });

  it("reports resolved depth and whether it can grow further", () => {
    const { tree } = expandRings(baseCtx(), providers, config, ["create"]);
    expect(resolvedDepth(tree)).toBe(2);
    // Deepest ring (create's children) are leaves → cannot expand further.
    expect(canExpand(tree, config)).toBe(false);
    // A single-ring tree whose options have children CAN expand.
    const shallow = expandRings(baseCtx(), providers, { ...config, maxDepth: 1 }, []);
    expect(canExpand(shallow.tree, { maxDepth: 1 })).toBe(false); // capped by maxDepth
    expect(canExpand(shallow.tree, { maxDepth: 3 })).toBe(true); // room + children
  });

  it("flattens the root ring back into ordered sections", () => {
    const { tree } = expandRings(baseCtx(), providers, config, []);
    expect(rootRing(tree)?.depth).toBe(0);
    const sections = ringsToSections(baseCtx(), tree, ["create", "modify"]);
    expect(sections.map((s) => s.group)).toEqual(["create", "modify"]);
  });
});
