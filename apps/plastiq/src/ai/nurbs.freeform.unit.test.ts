// §15 Lane B — keep-editable freeform land from service surface JSON.
// Pure adapter: no network. Proves freeformDocFromSurfaces drives serviceSurfaceToNurbs
// and produces freeform features the rebuild evaluator accepts as a document shape.

import { describe, expect, it } from "vitest";
import { freeformDocFromSurfaces } from "./nurbs.js";
import type { NurbsSurfaceJson } from "@plastiq/nurbs";

/** Minimal bilinear plane as service wire (compact knots). */
const PLANE_WIRE: NurbsSurfaceJson = {
  poles: [
    [
      [0, 0, 0],
      [0.04, 0, 0],
    ],
    [
      [0, 0.03, 0],
      [0.04, 0.03, 0],
    ],
  ],
  weights: [],
  u_knots: [0, 1],
  v_knots: [0, 1],
  u_mults: [2, 2],
  v_mults: [2, 2],
  u_degree: 1,
  v_degree: 1,
  u_periodic: false,
  v_periodic: false,
};

describe("freeformDocFromSurfaces (§15 Lane B keep-editable)", () => {
  it("lands one freeform feature with control-net surface JSON", () => {
    const doc = freeformDocFromSurfaces([PLANE_WIRE], "Organic fit");
    expect(doc.features).toHaveLength(1);
    const f = doc.features[0]!;
    expect(f.type).toBe("freeform");
    expect(f.data?.["kind"]).toBe("custom");
    const surface = f.data?.["surface"] as {
      degU: number;
      controlNet: number[][][];
      knotsU: number[];
    };
    expect(surface.degU).toBe(1);
    expect(surface.controlNet).toHaveLength(2);
    expect(surface.controlNet[0]).toHaveLength(2);
    // Expanded clamped knots for deg-1, 2 poles: [0,0,1,1].
    expect(surface.knotsU).toEqual([0, 0, 1, 1]);
    expect(f.name).toBe("Organic fit");
  });

  it("lands one freeform feature per surface", () => {
    const doc = freeformDocFromSurfaces([PLANE_WIRE, PLANE_WIRE], "Multi");
    expect(doc.features).toHaveLength(2);
    expect(doc.features.every((f) => f.type === "freeform")).toBe(true);
  });

  it("rejects an empty surfaces list loudly", () => {
    expect(() => freeformDocFromSurfaces([])).toThrow(/no surfaces/);
  });
});
