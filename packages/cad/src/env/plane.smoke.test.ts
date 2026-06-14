// datum planes — SMOKE tests: every builder/accessor runs and returns sane shapes.

import { describe, expect, it } from "vitest";

import {
  type DatumPlane,
  offsetPlane,
  planePointToWorld,
  planeXY,
  planeXZ,
  planeYAxis,
  planeYZ,
} from "./plane.js";

const finite3 = (v: readonly number[]): boolean => v.length === 3 && v.every(Number.isFinite);
const planeOk = (p: DatumPlane): boolean => finite3(p.origin) && finite3(p.normal) && finite3(p.xAxis);

describe("datum planes — smoke", () => {
  it("the three world planes are well-formed", () => {
    expect(planeOk(planeXY())).toBe(true);
    expect(planeOk(planeXZ())).toBe(true);
    expect(planeOk(planeYZ())).toBe(true);
  });
  it("offsetPlane / planeYAxis / planePointToWorld run cleanly", () => {
    expect(planeOk(offsetPlane(planeXY(), 1))).toBe(true);
    expect(finite3(planeYAxis(planeXZ()))).toBe(true);
    expect(finite3(planePointToWorld(planeXZ(), 1, 2))).toBe(true);
  });
});
