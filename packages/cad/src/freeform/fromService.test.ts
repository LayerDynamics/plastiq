// §15 Lane B — service wire → freeform NurbsSurface adapter.

import { describe, expect, it } from "vitest";
import { evaluate } from "./deBoor.js";
import { expandCompactKnots, serviceSurfaceToNurbs } from "./fromService.js";
import { planeSurface } from "./generators.js";
import { validateSurface } from "./nurbsSurface.js";

describe("expandCompactKnots", () => {
  it("repeats each unique knot by its multiplicity", () => {
    expect(expandCompactKnots([0, 1], [3, 3])).toEqual([0, 0, 0, 1, 1, 1]);
    expect(expandCompactKnots([0, 0.5, 1], [2, 1, 2])).toEqual([0, 0, 0.5, 1, 1]);
  });

  it("rejects mismatched lengths", () => {
    expect(() => expandCompactKnots([0, 1], [3])).toThrow(/unique length/);
  });
});

describe("serviceSurfaceToNurbs", () => {
  it("round-trips a planar freeform surface through compact knots", () => {
    // A bilinear plane as freeform, then re-encoded as service wire (compact knots).
    const plane = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], 0.04, 0.03);
    const wire = {
      poles: plane.controlNet.map((row) => row.map((p) => [p[0], p[1], p[2]])),
      weights: [] as number[][],
      // Compact: unique ends with mult = deg+1 for a clamped degree-1 surface.
      u_knots: [0, 1],
      v_knots: [0, 1],
      u_mults: [2, 2],
      v_mults: [2, 2],
      u_degree: 1,
      v_degree: 1,
    };
    const surf = serviceSurfaceToNurbs(wire);
    expect(() => validateSurface(surf)).not.toThrow();
    // Corner evaluations match the original plane.
    expect(evaluate(surf, 0, 0)).toEqual(evaluate(plane, 0, 0));
    expect(evaluate(surf, 1, 1)[0]).toBeCloseTo(0.04, 12);
    expect(evaluate(surf, 1, 1)[1]).toBeCloseTo(0.03, 12);
  });
});
