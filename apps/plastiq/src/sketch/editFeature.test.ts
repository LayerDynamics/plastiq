// editSketchFeature / finishSketchFeature — the shared "open the sketch editor"
// and "Finish (commit) the sketch" actions used by both the feature tree and the
// canvas context menu. Driven through the real sketch + cad stores (no mocks).

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initSketchSolver } from "@plastiq/cad";
import { useSketchStore } from "./sketchStore.js";
import { useCadStore } from "../store/store.js";
import { editSketchFeature, finishSketchFeature } from "./editFeature.js";
import type { EditorFeature } from "../store/types.js";

const sk = () => useSketchStore.getState();
const cad = () => useCadStore.getState();

beforeAll(async () => {
  await initSketchSolver();
  useSketchStore.getState().setSolverReady(true);
}, 120_000);

beforeEach(() => {
  cad().reset();
  sk().exitSketch(); // ensure we don't start a test mid-sketch
});

/** Draw a closed axis-aligned rectangle in the active sketch (2 clicks). */
function drawRectangle(): void {
  sk().setTool("rectangle");
  sk().clickAt(0, 0);
  sk().clickAt(0.04, 0.02);
}

describe("finishSketchFeature", () => {
  it("returns false and stays in the sketcher with no buildable profile", () => {
    sk().enterSketch("XY");
    sk().setTool("line");
    sk().clickAt(0, 0);
    sk().clickAt(0.05, 0); // a single open segment — no closed loop
    const before = cad().features.length;
    expect(finishSketchFeature()).toBe(false);
    expect(sk().active).toBe(true); // still editing — work is NOT discarded
    expect(cad().features.length).toBe(before); // nothing persisted
  });

  it("commits a closed profile as a NEW sketch feature and exits sketch mode", () => {
    sk().enterSketch("XY");
    drawRectangle();
    expect(finishSketchFeature()).toBe(true);
    expect(sk().active).toBe(false); // left the sketcher
    const sketches = cad().features.filter((f) => f.type === "sketch");
    expect(sketches).toHaveLength(1);
    const data = sketches[0]!.data!;
    expect(data["profile"]).toBeTruthy(); // a derived closed profile
    expect(data["model"]).toBeTruthy(); // the constrained model is persisted
    expect((data["plane"] as { base?: string }).base).toBe("XY"); // the sketch's own plane
  });

  it("UPDATES the edited feature in place (no new feature) when editingFeatureId is set", () => {
    sk().enterSketch("XY");
    drawRectangle();
    finishSketchFeature();
    const created = cad().features.find((f) => f.type === "sketch")!;
    const count = cad().features.length;

    // Re-open it for editing and Finish again → it must UPDATE, not append.
    expect(editSketchFeature(created)).toBe(true);
    expect(sk().editingFeatureId).toBe(created.id);
    expect(finishSketchFeature()).toBe(true);
    expect(cad().features.length).toBe(count); // same feature updated, none added
  });
});

describe("editSketchFeature", () => {
  it("returns false for a non-sketch feature (caller falls back, e.g. to rename)", () => {
    const box: EditorFeature = {
      id: "b1",
      type: "box",
      params: { dx: 0.01, dy: 0.01, dz: 0.01 },
    };
    expect(editSketchFeature(box)).toBe(false);
    expect(sk().active).toBe(false);
  });

  it("returns false for a sketch feature that carries no model", () => {
    const sketch: EditorFeature = { id: "s1", type: "sketch", data: { profile: {} } };
    expect(editSketchFeature(sketch)).toBe(false);
    expect(sk().active).toBe(false);
  });

  it("enters the sketcher on the feature's own plane + model for an editable sketch", () => {
    sk().enterSketch("XY");
    drawRectangle();
    finishSketchFeature();
    const created = cad().features.find((f) => f.type === "sketch")!;

    expect(editSketchFeature(created)).toBe(true);
    expect(sk().active).toBe(true);
    expect(sk().editingFeatureId).toBe(created.id);
    // The re-entered model is the feature's persisted one (the rectangle's 4 corners).
    expect(sk().model.points).toHaveLength(4);
  });
});
