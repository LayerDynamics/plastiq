import { describe, expect, it, vi } from "vitest";
import { createRecmManager } from "./manager.js";
import { createRecmConfig } from "../config.js";
import type { RecmContext, RecmOptionProvider } from "../types.js";

function makeProviders(
  ran: string[],
): readonly RecmOptionProvider<RecmContext, "create" | "modify">[] {
  return [
    (ctx) => [
      {
        id: "create",
        group: "create",
        label: "Create",
        children: () => [
          { id: "box", group: "create", label: "Box", run: () => ran.push("box") },
          {
            id: "locked",
            group: "create",
            label: "Locked",
            enabled: () => false,
            run: () => ran.push("locked"),
          },
        ],
      },
      {
        id: "modify",
        group: "modify",
        label: "Modify",
        visible: () => ctx.selection.length > 0,
        children: () => [
          { id: "delete", group: "modify", label: "Delete", danger: true, run: () => ran.push("delete") },
        ],
      },
    ],
  ];
}

const config = createRecmConfig<"create" | "modify">({ groupOrder: ["create", "modify"] });

describe("recm manager", () => {
  it("builds a normalized context and resolves sections gated on selection", () => {
    const manager = createRecmManager({ config, providers: makeProviders([]) });
    const empty = manager.buildContext({ origin: { kind: "screen", x: 0, y: 0 } });
    expect(manager.sections(empty).map((s) => s.group)).toEqual(["create"]);

    const selected = manager.buildContext({
      origin: { kind: "screen", x: 0, y: 0 },
      selection: [{ id: "a", kind: "face" }],
    });
    expect(manager.sections(selected).map((s) => s.group)).toEqual(["create", "modify"]);
  });

  it("expands the active branch into rings", () => {
    const manager = createRecmManager({ config, providers: makeProviders([]) });
    const ctx = manager.buildContext({ origin: { kind: "screen", x: 0, y: 0 } });
    const { tree } = manager.expand(ctx, ["create"]);
    expect(tree.rings[0]?.options.map((o) => o.id)).toContain("create");
    expect(tree.rings[1]?.options.map((o) => o.id)).toEqual(["box", "locked"]);
  });

  it("runs a terminal option (firing its run + the runOption dispatch) and returns true", () => {
    const ran: string[] = [];
    const dispatch = vi.fn();
    const manager = createRecmManager({ config, providers: makeProviders(ran), runOption: dispatch });
    const ctx = manager.buildContext({ origin: { kind: "screen", x: 0, y: 0 } });
    expect(manager.run(ctx, ["create"], "box")).toBe(true);
    expect(ran).toEqual(["box"]);
    expect(dispatch).toHaveBeenCalledWith("box", expect.objectContaining({ depth: 1 }));
  });

  it("does not run a parent/group id (it is an expand gesture, not terminal)", () => {
    const ran: string[] = [];
    const manager = createRecmManager({ config, providers: makeProviders(ran) });
    const ctx = manager.buildContext({ origin: { kind: "screen", x: 0, y: 0 } });
    expect(manager.run(ctx, [], "create")).toBe(false);
    expect(ran).toEqual([]);
  });

  it("does not run a disabled option", () => {
    const ran: string[] = [];
    const manager = createRecmManager({ config, providers: makeProviders(ran) });
    const ctx = manager.buildContext({ origin: { kind: "screen", x: 0, y: 0 } });
    expect(manager.run(ctx, ["create"], "locked")).toBe(false);
    expect(ran).toEqual([]);
  });
});
