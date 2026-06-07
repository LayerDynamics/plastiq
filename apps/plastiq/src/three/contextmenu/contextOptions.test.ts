import { describe, expect, it } from "vitest";
import type { FaceRef } from "@plastiq/cad";
import { buildMenuSections, menuItemIds } from "./contextOptions.js";
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
    worldPoint: [0, 0, 0],
    ...over,
  };
}

const faceRef: FaceRef = { normal: [0, 0, 1] } as FaceRef;

describe("contextOptions — buildMenuSections (context-filtered)", () => {
  it("empty space: new sketches + view actions, no dress-up", () => {
    const ids = menuItemIds(makeTarget({ kind: "empty" }));
    expect(ids).toEqual(
      expect.arrayContaining(["new-sketch-xy", "new-sketch-xz", "new-sketch-yz", "fit-view", "section", "measure"]),
    );
    expect(ids).not.toContain("fillet");
    expect(ids).not.toContain("shell");
    expect(ids).not.toContain("clear-selection"); // no picks
  });

  it("a single face: sketch-on-face + face dress-up, not edge tools", () => {
    const ids = menuItemIds(
      makeTarget({ kind: "face", picks: [{ kind: "face", id: 1 }], refs: { faces: { 1: faceRef }, edges: {} } }),
    );
    expect(ids).toEqual(expect.arrayContaining(["sketch-on-face", "shell", "draft"]));
    expect(ids).toContain("clear-selection");
    expect(ids).not.toContain("fillet");
  });

  it("edges: fillet/chamfer, not face tools", () => {
    const ids = menuItemIds(makeTarget({ kind: "edge", selMode: "edge", picks: [{ kind: "edge", id: 5 }] }));
    expect(ids).toEqual(expect.arrayContaining(["fillet", "chamfer"]));
    expect(ids).not.toContain("shell");
  });

  it("a body: transform gizmo entries", () => {
    const ids = menuItemIds(makeTarget({ kind: "body", selMode: "body", picks: [{ kind: "body", id: 0 }] }));
    expect(ids).toEqual(expect.arrayContaining(["gizmo-translate", "gizmo-rotate"]));
  });

  it("extrude/cut/revolve appear only when a profile exists", () => {
    expect(menuItemIds(makeTarget({ kind: "empty", hasProfile: false }))).not.toContain("extrude");
    const withProfile = menuItemIds(makeTarget({ kind: "empty", hasProfile: true }));
    expect(withProfile).toEqual(expect.arrayContaining(["extrude", "cut", "revolve"]));
  });

  it("extrude-to-face is disabled (shown) until a profile exists", () => {
    const sections = buildMenuSections(
      makeTarget({ kind: "face", picks: [{ kind: "face", id: 1 }], refs: { faces: { 1: faceRef }, edges: {} }, hasProfile: false }),
    );
    const item = sections.flatMap((s) => s.items).find((i) => i.id === "extrude-to-face");
    expect(item?.enabled).toBe(false);
  });

  it("a selected feature: history ops, with delete last (danger group)", () => {
    const sections = buildMenuSections(
      makeTarget({ kind: "feature", selectedFeatureId: "f1", features: [{ id: "f1", type: "extrude", params: { height: 1 } }] }),
    );
    const ids = sections.flatMap((s) => s.items.map((i) => i.id));
    expect(ids).toEqual(expect.arrayContaining(["suppress", "rollback", "delete-feature"]));
    expect(ids[ids.length - 1]).toBe("delete-feature");
    expect(sections[sections.length - 1]!.group).toBe("danger");
  });

  it("suppress label reflects the feature's current state", () => {
    const onLabel = buildMenuSections(
      makeTarget({ kind: "feature", selectedFeatureId: "f1", features: [{ id: "f1", type: "extrude", suppressed: true }] }),
    )
      .flatMap((s) => s.items)
      .find((i) => i.id === "suppress")?.label;
    expect(onLabel).toBe("Unsuppress");
  });

  it("simulating: only playback controls, no modeling", () => {
    const ids = menuItemIds(makeTarget({ kind: "empty", simulating: true }));
    expect(ids).toEqual(expect.arrayContaining(["sim-pause", "sim-step", "sim-rewind", "sim-stop"]));
    expect(ids).not.toContain("new-sketch-xy");
    expect(ids).not.toContain("section");
  });

  it("mate mode: mate actions, enabled only with two picks", () => {
    const oneSection = buildMenuSections(makeTarget({ kind: "body", mateMode: true, matePickCount: 1 }));
    const coincident = oneSection.flatMap((s) => s.items).find((i) => i.id === "mate-coincident");
    expect(coincident?.enabled).toBe(false);
    const twoSection = buildMenuSections(makeTarget({ kind: "body", mateMode: true, matePickCount: 2 }));
    expect(twoSection.flatMap((s) => s.items).find((i) => i.id === "mate-coincident")?.enabled).toBe(true);
  });

  it("an assembly instance: fixed/explode/interference + remove (danger)", () => {
    const ids = menuItemIds(makeTarget({ kind: "assemblyInstance", instanceId: "i1" }));
    expect(ids).toEqual(expect.arrayContaining(["instance-fixed", "explode", "interference", "remove-instance"]));
  });

  it("groups appear in the fixed top-to-bottom order", () => {
    const sections = buildMenuSections(
      makeTarget({ kind: "face", picks: [{ kind: "face", id: 1 }], refs: { faces: { 1: faceRef }, edges: {} } }),
    );
    const order = sections.map((s) => s.group);
    // create (sketch-on-face) → modify (shell/draft) → view → selection
    expect(order.indexOf("create")).toBeLessThan(order.indexOf("modify"));
    expect(order.indexOf("modify")).toBeLessThan(order.indexOf("view"));
    expect(order.indexOf("view")).toBeLessThan(order.indexOf("selection"));
  });
});
