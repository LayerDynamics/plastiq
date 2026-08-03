// nurbsSurface — structural validation tests for the freeform surface data model.

import { describe, expect, it } from "vitest";

import {
  domain,
  findSpan,
  findSpanMult,
  isRational,
  makeNurbsSurface,
  numU,
  numV,
  validateSurface,
  type NurbsSurface,
} from "./index.js";

/** A minimal valid clamped bilinear patch (degU = degV = 1, 2×2 net). */
function bilinear(): NurbsSurface {
  return {
    degU: 1,
    degV: 1,
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
    controlNet: [
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
      [
        [1, 0, 0],
        [1, 1, 1],
      ],
    ],
  };
}

describe("nurbsSurface — structure + validation", () => {
  it("accepts a well-formed surface and reports its dimensions", () => {
    const s = bilinear();
    expect(() => validateSurface(s)).not.toThrow();
    expect(numU(s)).toBe(2);
    expect(numV(s)).toBe(2);
    expect(isRational(s)).toBe(false);
    expect(domain(s)).toEqual({ u0: 0, u1: 1, v0: 0, v1: 1 });
  });

  it("treats a weighted surface as rational", () => {
    const s = bilinear();
    s.weights = [
      [1, 1],
      [1, 2],
    ];
    expect(isRational(s)).toBe(true);
    expect(() => validateSurface(s)).not.toThrow();
  });

  it("rejects a degree below 1", () => {
    const s = bilinear();
    s.degU = 0;
    expect(() => validateSurface(s)).toThrow(/degU/);
  });

  it("rejects a wrong u knot count (must be numU + degU + 1)", () => {
    const s = bilinear();
    s.knotsU = [0, 0, 1]; // one short
    expect(() => validateSurface(s)).toThrow(/knotsU length/);
  });

  it("rejects a wrong v knot count", () => {
    const s = bilinear();
    s.knotsV = [0, 0, 1, 1, 1]; // one long
    expect(() => validateSurface(s)).toThrow(/knotsV length/);
  });

  it("rejects a non-monotonic knot vector", () => {
    const s = bilinear();
    s.knotsU = [0, 0, 1, 0.5];
    expect(() => validateSurface(s)).toThrow(/non-decreasing/);
  });

  it("rejects a non-rectangular control net", () => {
    const s = bilinear();
    (s.controlNet[1] as unknown as number[][]).push([2, 2, 2]);
    expect(() => validateSurface(s)).toThrow(/rectangular/);
  });

  it("rejects too few control points for the degree", () => {
    const s: NurbsSurface = {
      degU: 2,
      degV: 1,
      knotsU: [0, 0, 1, 1], // only 2 control rows, need degU+1 = 3
      knotsV: [0, 0, 1, 1],
      controlNet: [
        [
          [0, 0, 0],
          [0, 1, 0],
        ],
        [
          [1, 0, 0],
          [1, 1, 0],
        ],
      ],
    };
    expect(() => validateSurface(s)).toThrow(/control rows/);
  });

  it("rejects a non-positive weight", () => {
    const s = bilinear();
    s.weights = [
      [1, 1],
      [1, 0],
    ];
    expect(() => validateSurface(s)).toThrow(/> 0/);
  });

  it("makeNurbsSurface validates and returns the surface", () => {
    const s = makeNurbsSurface(bilinear());
    expect(numU(s)).toBe(2);
  });

  it("findSpan clamps the endpoints and locates interior spans", () => {
    const knots = [0, 0, 0, 0.5, 1, 1, 1]; // deg 2, numCtrl 4
    expect(findSpan(4, 2, 0, knots)).toBe(2); // left clamp
    expect(findSpan(4, 2, 1, knots)).toBe(3); // right clamp → numCtrl-1
    expect(findSpan(4, 2, 0.25, knots)).toBe(2);
    expect(findSpan(4, 2, 0.75, knots)).toBe(3);
  });

  it("findSpanMult reports the multiplicity of an existing knot", () => {
    const knots = [0, 0, 0, 0.5, 1, 1, 1];
    expect(findSpanMult(4, 2, 0.5, knots).mult).toBe(1);
    expect(findSpanMult(4, 2, 0.25, knots).mult).toBe(0);
  });
});
