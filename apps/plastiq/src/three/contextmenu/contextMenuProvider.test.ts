import { beforeEach, describe, expect, it } from "vitest";
import { useCadStore } from "../../store/store.js";
import { useContextMenu } from "./contextMenuProvider.js";
import { buildMenuSections } from "./contextOptions.js";
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
    worldPoint: [4, 5, 6],
    ...over,
  };
}

describe("contextMenuProvider — open/close/runAction", () => {
  beforeEach(() => {
    useContextMenu.getState().close();
    useCadStore.getState().reset();
  });

  it("openAt records the target, sections, and the world anchor", () => {
    const t = makeTarget();
    useContextMenu.getState().openAt(t, buildMenuSections(t));
    const s = useContextMenu.getState();
    expect(s.open).toBe(true);
    expect(s.anchor).toEqual([4, 5, 6]);
    expect(s.target).toBe(t);
    expect(s.sections.length).toBeGreaterThan(0);
  });

  it("close clears everything", () => {
    const t = makeTarget();
    useContextMenu.getState().openAt(t, buildMenuSections(t));
    useContextMenu.getState().close();
    const s = useContextMenu.getState();
    expect(s.open).toBe(false);
    expect(s.anchor).toBeNull();
    expect(s.target).toBeNull();
    expect(s.sections).toEqual([]);
  });

  it("runAction runs the catalog action against the open target, then closes", () => {
    const t = makeTarget({ measuring: false });
    useContextMenu.getState().openAt(t, buildMenuSections(t));
    useContextMenu.getState().runAction("measure");
    expect(useCadStore.getState().measuring).toBe(true);
    expect(useContextMenu.getState().open).toBe(false);
  });

  it("runAction never runs a disabled action (honours enabled())", () => {
    // sketch-on-face is disabled with no resolvable face selected.
    const t = makeTarget({ kind: "face", picks: [], solverReady: true });
    useContextMenu.getState().openAt(t, buildMenuSections(t));
    const before = useCadStore.getState().features.length;
    useContextMenu.getState().runAction("sketch-on-face");
    expect(useCadStore.getState().features.length).toBe(before);
    expect(useContextMenu.getState().open).toBe(false);
  });

  it("runAction is a no-op (just closes) when nothing is open", () => {
    useContextMenu.getState().close();
    expect(() => useContextMenu.getState().runAction("measure")).not.toThrow();
    expect(useCadStore.getState().measuring).toBe(false);
  });
});
