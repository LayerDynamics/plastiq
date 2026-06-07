import { describe, expect, it } from "vitest";
import type { EditorFeature } from "../../store/types.js";
import {
  hasSketchProfile,
  resolveContextTarget,
  type CadSnapshot,
  type RightClickHit,
  type SketchSnapshot,
} from "./contextSelection.js";

function makeCad(over: Partial<CadSnapshot> = {}): CadSnapshot {
  return {
    picks: [],
    selMode: "face",
    selectionRefs: { faces: {}, edges: {} },
    features: [],
    selectedFeatureId: null,
    mateMode: false,
    matePicks: [],
    simulating: false,
    simPaused: false,
    section: null,
    measuring: false,
    explodeFactor: 0,
    gizmoMode: "translate",
    ...over,
  };
}

const noSketch: SketchSnapshot = { active: false, selection: [], solverReady: true, model: null };
const W: [number, number, number] = [1, 2, 3];

function resolve(cad: CadSnapshot, hit: RightClickHit | null, sketch = noSketch) {
  return resolveContextTarget({ cad, sketch, hit, worldPoint: W });
}

describe("contextSelection — resolveContextTarget (kind precedence)", () => {
  it("empty space → 'empty'", () => {
    expect(resolve(makeCad(), null).kind).toBe("empty");
  });

  it("a face/edge/vertex/body hit takes the hit's kind", () => {
    expect(resolve(makeCad(), { kind: "face", id: 7 }).kind).toBe("face");
    expect(resolve(makeCad({ selMode: "edge" }), { kind: "edge", id: 7 }).kind).toBe("edge");
    expect(resolve(makeCad({ selMode: "vertex" }), { kind: "vertex", id: 7 }).kind).toBe("vertex");
    expect(resolve(makeCad({ selMode: "body" }), { kind: "body", id: 0 }).kind).toBe("body");
  });

  it("falls back to the existing selection's kind when there is no fresh hit", () => {
    const cad = makeCad({ picks: [{ kind: "edge", id: 5 }], selMode: "edge" });
    expect(resolve(cad, null).kind).toBe("edge");
  });

  it("a selected feature (no 3D picks/hit) → 'feature'", () => {
    const features: EditorFeature[] = [{ id: "f1", type: "sketch" }];
    expect(resolve(makeCad({ features, selectedFeatureId: "f1" }), null).kind).toBe("feature");
  });

  it("an assembly-instance hit → 'assemblyInstance' and carries the instanceId", () => {
    const t = resolve(makeCad({ selMode: "face" }), { kind: "face", id: 3, instanceId: "i2" });
    expect(t.kind).toBe("assemblyInstance");
    expect(t.instanceId).toBe("i2");
  });

  it("sketcher open wins over everything → 'sketchEntity'", () => {
    const sketch: SketchSnapshot = { active: true, selection: ["e1"], solverReady: true, model: null };
    const t = resolve(makeCad({ picks: [{ kind: "face", id: 1 }] }), { kind: "face", id: 1 }, sketch);
    expect(t.kind).toBe("sketchEntity");
    expect(t.inSketch).toBe(true);
    expect(t.sketchSelection).toEqual(["e1"]);
  });

  it("propagates worldPoint, mode flags, refs, and the profile gate", () => {
    const features: EditorFeature[] = [{ id: "f1", type: "sketch", data: { profile: {} } }];
    const cad = makeCad({
      features,
      mateMode: true,
      matePicks: [{}, {}],
      simulating: true,
      simPaused: true,
      section: { axis: "y", t: 0.25 },
      measuring: true,
      explodeFactor: 0.5,
      gizmoMode: "rotate",
    });
    const t = resolve(cad, null);
    expect(t.worldPoint).toEqual(W);
    expect(t.hasProfile).toBe(true);
    expect(t.mateMode).toBe(true);
    expect(t.matePickCount).toBe(2);
    expect(t.simulating).toBe(true);
    expect(t.simPaused).toBe(true);
    expect(t.section).toEqual({ axis: "y", t: 0.25 });
    expect(t.measuring).toBe(true);
    expect(t.explodeFactor).toBe(0.5);
    expect(t.gizmoMode).toBe("rotate");
  });
});

describe("contextSelection — hasSketchProfile (FR-30 gate parity)", () => {
  it("true only for an unsuppressed sketch with a profile or model", () => {
    expect(hasSketchProfile([{ id: "f1", type: "sketch", data: { profile: {} } }])).toBe(true);
    expect(hasSketchProfile([{ id: "f1", type: "sketch", data: { model: {} } }])).toBe(true);
    expect(hasSketchProfile([{ id: "f1", type: "sketch" }])).toBe(false);
    expect(
      hasSketchProfile([{ id: "f1", type: "sketch", data: { profile: {} }, suppressed: true }]),
    ).toBe(false);
    expect(hasSketchProfile([{ id: "f1", type: "extrude", params: { height: 1 } }])).toBe(false);
  });
});
