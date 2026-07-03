// Sketch.toWire failure-path cleanup — UNIT (fake kernel, NOT real OCCT).
//
// toWire builds many OCCT temporaries per segment; a Standard_Failure thrown
// mid-loop (collinear arc points in GC_MakeArcOfCircle_4, a failed spline fit in
// GeomAPI_PointsToBSpline_2, a degenerate circle) formerly bypassed the batch
// cleanup and leaked everything already made in the long-lived geometry worker.
// Same fake-kernel `.delete()`-spy pattern as action/cleanup.unit.test.ts: each
// fake records its own label when freed, and we assert the labels.

import { beforeEach, describe, expect, it } from "vitest";

import type { Occt } from "../oc/init.js";
import { planeXY } from "../env/plane.js";
import { Sketch } from "./sketch.js";

let deleted: string[];
/** A `.delete()` that records `label` against the current run's ledger. */
const del = (label: string) => () => deleted.push(label);
const count = (label: string): number => deleted.filter((l) => l === label).length;

beforeEach(() => {
  deleted = [];
});

describe("circle profiles", () => {
  it("rejects a zero radius BEFORE allocating any OCCT temporary", () => {
    // An empty fake kernel: if toWire touched `oc` at all it would TypeError,
    // not throw the radius message — proving validation precedes allocation.
    const oc = {} as unknown as Occt;
    expect(() => Sketch.circle(planeXY(), 0, 0, 0).toWire(oc)).toThrow(/radius/);
    expect(deleted).toEqual([]);
  });

  it("rejects a negative radius before allocating", () => {
    expect(() => Sketch.circle(planeXY(), 0, 0, -0.01).toWire({} as unknown as Occt)).toThrow(
      /radius/,
    );
  });

  it("rejects a NaN radius before allocating", () => {
    expect(() => Sketch.circle(planeXY(), 0, 0, Number.NaN).toWire({} as unknown as Occt)).toThrow(
      /radius/,
    );
  });

  it("frees the centre/dir/axis/circle temporaries when MakeEdge throws", () => {
    const oc = {
      gp_Pnt_3: function () {
        return { delete: del("pnt") };
      },
      gp_Dir_4: function () {
        return { delete: del("dir") };
      },
      gp_Ax2_3: function () {
        return { delete: del("ax") };
      },
      gp_Circ_2: function () {
        return { delete: del("circ") };
      },
      BRepBuilderAPI_MakeEdge_8: function () {
        throw new Error("Standard_Failure: cannot build the circular edge");
      },
    } as unknown as Occt;

    expect(() => Sketch.circle(planeXY(), 0, 0, 0.01).toWire(oc)).toThrow(/Standard_Failure/);
    expect(deleted).toEqual(expect.arrayContaining(["pnt", "dir", "ax", "circ"]));
  });

  it("on success frees every temporary but NOT the returned wire", () => {
    const wire = { delete: del("WIRE-RESULT") };
    const oc = {
      gp_Pnt_3: function () {
        return { delete: del("pnt") };
      },
      gp_Dir_4: function () {
        return { delete: del("dir") };
      },
      gp_Ax2_3: function () {
        return { delete: del("ax") };
      },
      gp_Circ_2: function () {
        return { delete: del("circ") };
      },
      BRepBuilderAPI_MakeEdge_8: function () {
        return { Edge: () => ({ delete: del("edge") }), delete: del("edgeMaker") };
      },
      BRepBuilderAPI_MakeWire_2: function () {
        return { Wire: () => wire, delete: del("wireMaker") };
      },
    } as unknown as Occt;

    expect(Sketch.circle(planeXY(), 0, 0, 0.01).toWire(oc)).toBe(wire);
    expect(deleted).toEqual(
      expect.arrayContaining(["pnt", "dir", "ax", "circ", "edgeMaker", "edge", "wireMaker"]),
    );
    expect(deleted).not.toContain("WIRE-RESULT");
  });
});

/** A fake kernel for the polyline/arc/spline branch; segments succeed. */
function polylineOc(overrides: Record<string, unknown> = {}): Occt {
  return {
    gp_Pnt_3: function () {
      return { delete: del("pnt") };
    },
    BRepBuilderAPI_MakeWire_1: function () {
      return {
        Add_1: () => {},
        IsDone: () => true,
        Wire: () => ({ delete: del("WIRE-RESULT") }),
        delete: del("wireMaker"),
      };
    },
    BRepBuilderAPI_MakeEdge_3: function () {
      return { Edge: () => ({ delete: del("edge") }), delete: del("edgeMaker") };
    },
    GeomAbs_Shape: { GeomAbs_C2: 2 },
    ...overrides,
  } as unknown as Occt;
}

describe("polyline profiles", () => {
  it("frees the wireMaker and every made temporary when the arc maker throws (collinear points)", () => {
    const oc = polylineOc({
      GC_MakeArcOfCircle_4: function () {
        throw new Error("Standard_Failure: the three points are collinear");
      },
    });
    const sk = new Sketch(planeXY()).lineTo(0, 0).lineTo(0.01, 0).arcTo(0.02, 0, 0.03, 0);

    expect(() => sk.toWire(oc)).toThrow(/Standard_Failure/);
    // The straight segment made 2 points + edgeMaker + edge; the arc made its
    // 3 points before GC_MakeArcOfCircle_4 threw. ALL are freed, plus the maker.
    expect(deleted).toContain("wireMaker");
    expect(count("pnt")).toBe(5);
    expect(count("edgeMaker")).toBe(1);
    expect(count("edge")).toBe(1);
  });

  it("frees the point array and its points when the spline fit throws", () => {
    const oc = polylineOc({
      TColgp_Array1OfPnt_2: function () {
        return { SetValue: () => {}, delete: del("arr") };
      },
      GeomAPI_PointsToBSpline_2: function () {
        throw new Error("Standard_Failure: spline fit failed");
      },
    });
    const sk = new Sketch(planeXY()).lineTo(0, 0).splineTo([
      [0.01, 0],
      [0.01, 0.01],
    ]);

    expect(() => sk.toWire(oc)).toThrow(/Standard_Failure/);
    expect(deleted).toContain("wireMaker");
    expect(deleted).toContain("arr");
    expect(count("pnt")).toBe(3); // start + the two through points
  });

  it("still frees everything on the IsDone() === false path", () => {
    const oc = polylineOc({
      BRepBuilderAPI_MakeWire_1: function () {
        return {
          Add_1: () => {},
          IsDone: () => false,
          Wire: () => ({ delete: del("WIRE-RESULT") }),
          delete: del("wireMaker"),
        };
      },
    });
    const sk = new Sketch(planeXY()).lineTo(0, 0).lineTo(0.01, 0).lineTo(0.01, 0.01);

    expect(() => sk.toWire(oc)).toThrow(/closed wire/);
    expect(deleted).toContain("wireMaker");
    expect(count("pnt")).toBe(6); // 2 segments + the auto-close segment
  });

  it("on success frees every temporary but NOT the returned wire", () => {
    const sk = new Sketch(planeXY()).lineTo(0, 0).lineTo(0.01, 0).lineTo(0.01, 0.01);
    const wire = sk.toWire(polylineOc());

    expect(wire).toBeDefined();
    expect(deleted).toContain("wireMaker");
    expect(count("pnt")).toBe(6);
    expect(count("edgeMaker")).toBe(3);
    expect(deleted).not.toContain("WIRE-RESULT");
  });
});
