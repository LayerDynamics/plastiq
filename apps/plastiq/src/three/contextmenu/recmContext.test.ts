import { afterEach, describe, expect, it } from "vitest";
import { resolveRecmTree } from "@plastiq/recm";
import {
  buildPlastiqRecmContext,
  buildPlastiqRecmProviders,
  buildPlastiqRenderedObjects,
  plastiqRecmManager,
  publishRecmMenuSeam,
  type RecmMenuSeam,
} from "./recmContext.js";
import type { ContextTarget } from "./contextSelection.js";

function makeTarget(over: Partial<ContextTarget> = {}): ContextTarget {
  return {
    kind: "empty",
    picks: [],
    selMode: "face",
    refs: { faces: {}, edges: {} },
    features: [],
    selectedFeatureId: null,
    inSketch: false,
    sketchSelection: [],
    sketchModel: null,
    mateMode: false,
    matePickCount: 0,
    simulating: false,
    simPaused: false,
    hasProfile: false,
    solverReady: true,
    section: null,
    measuring: false,
    explodeFactor: 0,
    gizmoMode: "translate",
    instanceId: null,
    worldPoint: [1, 2, 3],
    ...over,
  };
}

afterEach(() => {
  delete (globalThis as { __plastiqViewport?: unknown }).__plastiqViewport;
  delete (globalThis as { __plastiqRecmContext?: unknown }).__plastiqRecmContext;
});

describe("recm bridge", () => {
  it("derives live rendered objects and selection context from the viewport", () => {
    (globalThis as { __plastiqViewport?: unknown }).__plastiqViewport = {
      builtPart: { id: "built" },
      meshBodyCount: 2,
      instanceGroups: [{ userData: { instanceId: "a" } }, { userData: { instanceId: "b" } }],
    };
    const target = makeTarget({ picks: [{ kind: "face", id: 3 }] });
    const ctx = buildPlastiqRecmContext({
      target,
      source: "canvas",
      origin: { kind: "world", point: [1, 2, 3] },
      openMenus: true,
      menuDepth: 1,
    });
    expect(ctx.selection).toEqual([{ id: "face:3", kind: "face", value: { kind: "face", id: 3 } }]);
    expect(buildPlastiqRenderedObjects().map((item) => item.id)).toEqual([
      "built-part",
      "mesh-bodies",
      "instance:a",
      "instance:b",
    ]);
    expect(ctx.renderedMenus).toHaveLength(1);
  });

  it("builds recursive menu rings from the current target state", () => {
    const target = makeTarget({ kind: "face", picks: [{ kind: "face", id: 1 }] });
    const context = buildPlastiqRecmContext({
      target,
      source: "canvas",
      origin: { kind: "world", point: [0, 0, 0] },
      openMenus: true,
      menuDepth: 1,
    });
    const tree = resolveRecmTree(context, buildPlastiqRecmProviders(), {
      maxDepth: 3,
      groupOrder: ["create", "modify", "sketch", "assembly", "mate", "sim", "view", "selection", "feature", "danger"],
    });
    expect(tree.rings[0]?.options.length).toBeGreaterThan(0);
    const create = tree.rings[0]?.options.find((item) => item.id === "create");
    expect(create?.hasChildren).toBe(true);
    expect(tree.rings[1]?.options.length).toBeGreaterThan(0);
  });
});

// Full-chain integration: drive the SAME manager the live components drive
// (buildContext → expand), proving the live selection + rendered scene both reach
// the RecmContext AND shape the rings. No mocks — the real catalog + manager.
describe("recm bridge — context reaches the menu (integration)", () => {
  function menuFor(target: ContextTarget) {
    const context = plastiqRecmManager.buildContext(
      buildPlastiqRecmContext({
        target,
        source: "canvas",
        origin: { kind: "world", point: target.worldPoint },
        openMenus: true,
        menuDepth: 1,
      }),
    );
    return { context, expand: (path: string[] = []) => plastiqRecmManager.expand(context, path) };
  }
  const catIds = (target: ContextTarget): string[] =>
    menuFor(target).expand().tree.rings[0]?.options.map((o) => o.id) ?? [];
  const childIds = (target: ContextTarget, group: string): string[] =>
    menuFor(target).expand([group]).tree.rings[1]?.options.map((o) => o.id) ?? [];

  it("carries the live selection + rendered scene into the context the manager builds", () => {
    (globalThis as { __plastiqViewport?: unknown }).__plastiqViewport = {
      builtPart: { id: "built" },
      meshBodyCount: 3,
      instanceGroups: [{ userData: { instanceId: "a" } }],
    };
    const target = makeTarget({ kind: "face", picks: [{ kind: "face", id: 5 }] });
    const { context } = menuFor(target);
    // Selection came through from the 3D picks…
    expect(context.selection).toEqual([
      { id: "face:5", kind: "face", value: { kind: "face", id: 5 } },
    ]);
    // …the live scene inventory came through…
    expect(context.renderedObjects.map((o) => o.id)).toEqual([
      "built-part",
      "mesh-bodies",
      "instance:a",
    ]);
    // …the open menu is registered at its depth…
    expect(context.renderedMenus).toEqual([{ id: "context-menu", kind: "ring", depth: 1 }]);
    // …and the app target the providers key off is the very target we passed.
    expect(context.app?.target).toBe(target);
  });

  it("resolves DIFFERENT menus for different contexts (the context shapes the rings)", () => {
    const face = makeTarget({ kind: "face", picks: [{ kind: "face", id: 1 }] });
    const edge = makeTarget({ kind: "edge", selMode: "edge", picks: [{ kind: "edge", id: 2 }] });
    const body = makeTarget({ kind: "body", selMode: "body", picks: [{ kind: "body", id: 0 }] });
    const empty = makeTarget({ kind: "empty" });

    // A face offers face dress-up (Shell/Draft) under Modify, never edge Fillet.
    expect(childIds(face, "modify")).toEqual(expect.arrayContaining(["shell", "draft"]));
    expect(childIds(face, "modify")).not.toContain("fillet");
    // An edge offers edge dress-up (Fillet/Chamfer), never face Shell.
    expect(childIds(edge, "modify")).toEqual(expect.arrayContaining(["fillet", "chamfer"]));
    expect(childIds(edge, "modify")).not.toContain("shell");
    // A body offers the transform gizmos.
    expect(childIds(body, "modify")).toEqual(expect.arrayContaining(["gizmo-translate", "gizmo-rotate"]));
    // Empty space offers only sketch-creation, no dress-up category at all.
    expect(childIds(empty, "create")).toContain("new-sketch-xy");
    expect(catIds(empty)).not.toContain("modify");
  });

  it("publishes the reached context + resolved rings on the __plastiqRecmContext seam", () => {
    (globalThis as { __plastiqViewport?: unknown }).__plastiqViewport = { builtPart: { id: "b" } };
    const target = makeTarget({ kind: "face", picks: [{ kind: "face", id: 7 }] });
    const { context } = menuFor(target);
    publishRecmMenuSeam(context);
    const seam = (globalThis as { __plastiqRecmContext?: RecmMenuSeam | null }).__plastiqRecmContext;
    expect(seam).not.toBeNull();
    expect(seam?.source).toBe("canvas");
    expect(seam?.targetKind).toBe("face");
    expect(seam?.selection).toEqual([{ id: "face:7", kind: "face" }]);
    expect(seam?.renderedObjects.map((o) => o.id)).toContain("built-part");
    expect(seam?.categories).toEqual(expect.arrayContaining(["create", "modify"]));
    expect(seam?.activeChildren.length).toBeGreaterThan(0);

    publishRecmMenuSeam(null);
    expect((globalThis as { __plastiqRecmContext?: RecmMenuSeam | null }).__plastiqRecmContext).toBeNull();
  });
});
