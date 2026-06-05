import { describe, expect, it } from "vitest";
import { length, sub, type Vec3 } from "../math/index.js";
import {
  constructionAxis,
  constructionLine,
  constructionPoint,
  GLOBAL_ORIGIN,
  offsetPlane,
  planeThroughPoints,
  planeXY,
  planeYZ,
  planeZX,
  pointOnPlane,
  tiltedPlane,
} from "./index.js";

function close(a: Vec3, b: Vec3, tol = 1e-12): void {
  expect(length(sub(a, b))).toBeLessThan(tol);
}

describe("origin", () => {
  it("is the world frame at the origin", () => {
    expect(GLOBAL_ORIGIN.point).toEqual([0, 0, 0]);
    expect(GLOBAL_ORIGIN.z).toEqual([0, 0, 1]);
  });
});

describe("datum planes", () => {
  it("standard planes have the expected normals + frames", () => {
    expect(planeXY().normal).toEqual([0, 0, 1]);
    expect(planeYZ().normal).toEqual([1, 0, 0]);
    expect(planeZX().normal).toEqual([0, 1, 0]);
  });

  it("offset moves the origin along the normal", () => {
    const p = offsetPlane(planeXY(), 0.5);
    close(p.origin, [0, 0, 0.5]);
    expect(p.normal).toEqual([0, 0, 1]);
  });

  it("maps 2D sketch coords to 3D (pointOnPlane)", () => {
    close(pointOnPlane(planeXY(), 2, 3), [2, 3, 0]);
    close(pointOnPlane(offsetPlane(planeXY(), 1), 2, 3), [2, 3, 1]);
    close(pointOnPlane(planeYZ(), 2, 3), [0, 2, 3]);
  });

  it("planeThroughPoints derives a correct orthonormal frame", () => {
    const p = planeThroughPoints([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    close(p.uAxis, [1, 0, 0]);
    close(p.normal, [0, 0, 1]);
    close(p.vAxis, [0, 1, 0]);
    // u, v, normal are mutually orthonormal.
    expect(length(p.normal)).toBeCloseTo(1, 12);
  });

  it("tiltedPlane rotates the normal about uAxis by the given angle", () => {
    const p = tiltedPlane(planeXY(), Math.PI / 2); // +Z normal tilts toward −Y
    close(p.normal, [0, -1, 0]);
    close(p.uAxis, [1, 0, 0]); // hinge axis unchanged
  });
});

describe("construction geometry", () => {
  it("point/axis/line carry their data; axis direction is normalized", () => {
    expect(constructionPoint([1, 2, 3]).at).toEqual([1, 2, 3]);
    const ax = constructionAxis([0, 0, 0], [0, 0, 5]);
    close(ax.direction, [0, 0, 1]);
    const ln = constructionLine([0, 0, 0], [1, 1, 1]);
    expect(ln.start).toEqual([0, 0, 0]);
    expect(ln.end).toEqual([1, 1, 1]);
  });
});
