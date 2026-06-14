// datum planes — INTEGRATION tests: the real sketch-placement flow — offset a datum,
// then map a 2D sketch coordinate through it to a 3D world point (offsetPlane +
// planeYAxis + planePointToWorld composed, as feature creation does).

import { describe, expect, it } from "vitest";

import { offsetPlane, planePointToWorld, planeXY, planeYZ } from "./plane.js";

describe("datum planes — sketch placement (integration)", () => {
  it("a point on an XY plane offset +0.5 in Z lands at that height", () => {
    const sketchPlane = offsetPlane(planeXY(), 0.5);
    expect(planePointToWorld(sketchPlane, 2, 3)).toEqual([2, 3, 0.5]);
  });

  it("a point on a YZ plane offset +0.5 in X maps u→Y, v→Z at that X", () => {
    const sketchPlane = offsetPlane(planeYZ(), 0.5);
    expect(planePointToWorld(sketchPlane, 2, 3)).toEqual([0.5, 2, 3]);
  });

  it("the plane origin is the (0,0) sketch coordinate", () => {
    const p = offsetPlane(planeXY(), 1.25);
    expect(planePointToWorld(p, 0, 0)).toEqual(p.origin);
  });
});
