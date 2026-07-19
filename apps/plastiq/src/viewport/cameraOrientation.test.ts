// FR-12 — the view cube's orientation feed. The cube is a DOM overlay outside the
// Canvas, so it reads the camera through this module; these pin the maths that
// decides which faces you can see and where each corner lands.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  cubeBasis,
  DEFAULT_VIEW_QUAT,
  orientationChanged,
  projectCubePoint,
  type Quat,
} from "./cameraOrientation.js";

/**
 * Looking straight down an axis that is PARALLEL to the up vector (the exact top
 * view, dir = +Z, up = +Z) is degenerate: THREE nudges the basis rather than
 * producing a singular matrix, leaving a residual skew of order 1e-4. The real
 * camera takes the same path (setView → lookAt with the same up), so the tests
 * assert against that reality instead of pretending it is exact.
 */
const DEGENERATE_TOL = 1e-3;

/** The camera quaternion for looking at the origin FROM `dir` (Z-up, as the app). */
function lookFrom(dir: [number, number, number]): Quat {
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3(...dir).normalize(),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 1),
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w];
}

/** Depth of a cube face's normal — positive means it faces the viewer. */
const facing = (q: Quat, n: [number, number, number]): number =>
  projectCubePoint(cubeBasis(q), n, 36, 18).depth;

describe("orientationChanged", () => {
  it("ignores a resting camera but catches a real move", () => {
    expect(orientationChanged(DEFAULT_VIEW_QUAT, DEFAULT_VIEW_QUAT)).toBe(false);
    expect(orientationChanged(DEFAULT_VIEW_QUAT, lookFrom([0, 0, 1]))).toBe(true); // orbited to top
  });

  it("treats q and −q as the same rotation (they are)", () => {
    const q = lookFrom([1, -1, 1]);
    const negated: Quat = [-q[0], -q[1], -q[2], -q[3]];
    expect(orientationChanged(q, negated)).toBe(false);
  });
});

describe("cubeBasis / projectCubePoint — which faces the camera sees", () => {
  it("looking from +Z shows the TOP face and hides the bottom", () => {
    const q = lookFrom([0, 0, 1]);
    expect(facing(q, [0, 0, 1])).toBeGreaterThan(0.99); // top, straight on
    expect(facing(q, [0, 0, -1])).toBeLessThan(-0.99); // bottom, away
    expect(Math.abs(facing(q, [1, 0, 0]))).toBeLessThan(DEGENERATE_TOL); // right, edge-on
  });

  it("looking from −Y shows the FRONT face", () => {
    const q = lookFrom([0, -1, 0]);
    expect(facing(q, [0, -1, 0])).toBeGreaterThan(0.99);
    expect(facing(q, [0, 1, 0])).toBeLessThan(-0.99);
  });

  it("the viewport's DEFAULT view shows exactly top, back and right", () => {
    // Matches the starting camera [0.12, 0.1, 0.16]: +x, +y and +z all face you.
    const q = DEFAULT_VIEW_QUAT;
    for (const n of [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ] as [number, number, number][]) {
      expect(facing(q, n), `${n} should face the viewer`).toBeGreaterThan(0);
    }
    for (const n of [
      [0, 0, -1],
      [0, -1, 0],
      [-1, 0, 0],
    ] as [number, number, number][]) {
      expect(facing(q, n), `${n} should be hidden`).toBeLessThan(0);
    }
  });

  it("orbiting 180° swaps which faces are visible", () => {
    const front = lookFrom([0, -1, 0]);
    const back = lookFrom([0, 1, 0]);
    expect(facing(front, [0, -1, 0])).toBeGreaterThan(0);
    expect(facing(back, [0, -1, 0])).toBeLessThan(0); // the same face is now hidden
    expect(facing(back, [0, 1, 0])).toBeGreaterThan(0);
  });

  it("projects the cube centred, and a face-on view puts its centre at the middle", () => {
    const p = projectCubePoint(cubeBasis(lookFrom([0, 0, 1])), [0, 0, 1], 36, 18);
    expect(p.x).toBeCloseTo(36, 2);
    expect(p.y).toBeCloseTo(36, 2);
  });
});
