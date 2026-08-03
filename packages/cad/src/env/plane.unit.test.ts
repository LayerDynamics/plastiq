// datum planes — UNIT tests: each builder/accessor's exact frame in isolation.

import { describe, expect, it } from "vitest";

import {
  offsetPlane,
  planePointToWorld,
  planeXY,
  planeXZ,
  planeYAxis,
  planeYZ,
  worldPointToPlane,
} from "./plane.js";

describe("datum planes (unit)", () => {
  it("planeXY: origin at 0, normal +Z, xAxis +X", () => {
    expect(planeXY()).toEqual({ origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] });
  });
  it("planeXZ: normal +Y", () => expect(planeXZ().normal).toEqual([0, 1, 0]));
  it("planeYZ: normal +X, xAxis +Y", () => {
    expect(planeYZ().normal).toEqual([1, 0, 0]);
    expect(planeYZ().xAxis).toEqual([0, 1, 0]);
  });
  it("offsetPlane translates the origin along the normal, keeping the frame", () => {
    const p = offsetPlane(planeXY(), 0.5);
    expect(p.origin).toEqual([0, 0, 0.5]);
    expect(p.normal).toEqual([0, 0, 1]);
    expect(p.xAxis).toEqual([1, 0, 0]);
  });
  it("planeYAxis is normal × xAxis (orthonormal completion)", () => {
    expect(planeYAxis(planeXY())).toEqual([0, 1, 0]);
    expect(planeYAxis(planeYZ())).toEqual([0, 0, 1]);
  });
  it("planePointToWorld maps (u,v) along (xAxis,yAxis) from the origin", () => {
    expect(planePointToWorld(planeXY(), 2, 3)).toEqual([2, 3, 0]);
    expect(planePointToWorld(planeYZ(), 2, 3)).toEqual([0, 2, 3]);
  });
  it("worldPointToPlane is the inverse of planePointToWorld on-plane", () => {
    const w = planePointToWorld(planeXY(), 2, 3);
    const p = worldPointToPlane(planeXY(), w);
    expect(p.u).toBeCloseTo(2, 12);
    expect(p.v).toBeCloseTo(3, 12);
    expect(p.height).toBeCloseTo(0, 12);
  });
  it("worldPointToPlane reports signed height off the plane", () => {
    const p = worldPointToPlane(planeXY(), [1, 0, 0.5]);
    expect(p.u).toBeCloseTo(1, 12);
    expect(p.v).toBeCloseTo(0, 12);
    expect(p.height).toBeCloseTo(0.5, 12);
  });
});
