// buildSpineWire failure-path cleanup — UNIT (fake kernel, NOT real OCCT).
//
// A Standard_Failure from BRepBuilderAPI_MakeEdge_3 mid-loop formerly bypassed
// cleanup() entirely, leaking the wireMaker and every segment temporary in the
// long-lived geometry worker. Same `.delete()`-spy pattern as
// action/cleanup.unit.test.ts.

import { beforeEach, describe, expect, it } from "vitest";

import type { Occt } from "../oc/init.js";
import { buildSpineWire, type SpinePath } from "./spine.js";

let deleted: string[];
const del = (label: string) => () => deleted.push(label);
const count = (label: string): number => deleted.filter((l) => l === label).length;

beforeEach(() => {
  deleted = [];
});

const path = (points: ReadonlyArray<readonly [number, number, number]>): SpinePath => ({
  kind: "polyline",
  points,
});

function makeOc(overrides: Record<string, unknown> = {}): Occt {
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
    ...overrides,
  } as unknown as Occt;
}

describe("buildSpineWire frees everything when an edge constructor throws", () => {
  it("a MakeEdge Standard_Failure mid-loop still frees the wireMaker and prior temporaries", () => {
    let calls = 0;
    const oc = makeOc({
      BRepBuilderAPI_MakeEdge_3: function () {
        calls++;
        if (calls === 2) throw new Error("Standard_Failure: BRepBuilderAPI_MakeEdge");
        return { Edge: () => ({ delete: del("edge") }), delete: del("edgeMaker") };
      },
    });

    expect(() =>
      buildSpineWire(
        oc,
        path([
          [0, 0, 0],
          [0.01, 0, 0],
          [0.02, 0, 0],
        ]),
      ),
    ).toThrow(/Standard_Failure/);
    expect(deleted).toContain("wireMaker");
    // Segment 1: 2 points + edgeMaker + edge; segment 2: its 2 points were made
    // before the throwing constructor. All four points are freed.
    expect(count("pnt")).toBe(4);
    expect(count("edgeMaker")).toBe(1);
    expect(count("edge")).toBe(1);
  });

  it("the zero-length-spine rejection still frees the wireMaker", () => {
    const oc = makeOc();
    expect(() =>
      buildSpineWire(
        oc,
        path([
          [0, 0, 0],
          [0, 0, 0],
        ]),
      ),
    ).toThrow(/zero-length spine/);
    expect(deleted).toContain("wireMaker");
  });

  it("the IsDone() === false rejection still frees the wireMaker and temporaries", () => {
    const oc = makeOc({
      BRepBuilderAPI_MakeWire_1: function () {
        return {
          Add_1: () => {},
          IsDone: () => false,
          Wire: () => ({ delete: del("WIRE-RESULT") }),
          delete: del("wireMaker"),
        };
      },
    });
    expect(() =>
      buildSpineWire(
        oc,
        path([
          [0, 0, 0],
          [0.01, 0, 0],
        ]),
      ),
    ).toThrow(/spine wire/);
    expect(deleted).toContain("wireMaker");
    expect(count("pnt")).toBe(2);
  });

  it("on success frees every temporary but NOT the returned wire", () => {
    const wire = buildSpineWire(
      makeOc(),
      path([
        [0, 0, 0],
        [0.01, 0, 0],
        [0.01, 0.01, 0],
      ]),
    );
    expect(wire).toBeDefined();
    expect(deleted).toContain("wireMaker");
    expect(count("pnt")).toBe(4);
    expect(count("edgeMaker")).toBe(2);
    expect(deleted).not.toContain("WIRE-RESULT");
  });
});
