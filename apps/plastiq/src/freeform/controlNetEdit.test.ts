// §15 — control-net drag drives the shipped moveControlPoint path and updates
// freeform feature data (not a reimplementation of the kernel op).

import { describe, expect, it } from "vitest";
import { evaluate, planeSurface, tessellateFreeform } from "@plastiq/cad";
import { dragControlPoint, featureDataAfterControlDrag } from "./controlNetEdit.js";

describe("control-net drag (§15 Lane A(c))", () => {
  it("dragControlPoint moves a pole and re-tessellates without a worker", () => {
    const s = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], 0.04, 0.03);
    const dragged = dragControlPoint(s, 1, 1, [0.04, 0.03, 0.01]);
    expect(dragged.controlNet[1]![1]![2]).toBeCloseTo(0.01, 12);
    // Live tessellation path used by a control-net overlay (pure TS).
    const mesh = tessellateFreeform(dragged, { resU: 4, resV: 4 });
    expect(mesh.positions.length).toBeGreaterThan(0);
    // Corner evaluation follows the drag.
    expect(evaluate(dragged, 1, 1)[2]).toBeCloseTo(0.01, 9);
  });

  it("featureDataAfterControlDrag rewrites data.surface for rebuild", () => {
    const s = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], 0.02, 0.02);
    const data = { kind: "custom", surface: s };
    const next = featureDataAfterControlDrag(data, 0, 0, [0, 0, 0.005]);
    const surf = next["surface"] as { controlNet: number[][][] };
    expect(surf.controlNet[0]![0]![2]).toBeCloseTo(0.005, 12);
    // Original data.surface not mutated.
    expect(s.controlNet[0]![0]![2]).toBeCloseTo(0, 12);
  });

  it("featureDataAfterControlDrag fails loudly without a surface", () => {
    expect(() => featureDataAfterControlDrag({ kind: "plane" }, 0, 0, [0, 0, 0])).toThrow(
      /no data\.surface/,
    );
  });
});
