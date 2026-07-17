import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { EditorFeature } from "../store/types.js";
import {
  applyPlacement,
  eulerXYZQuat,
  findPlacement,
  IDENTITY_PLACEMENT,
  isIdentityPlacement,
  placementFromFeature,
  placementParams,
  placementPoseOf,
  PLACEMENT_TYPE,
  quatToEulerXYZ,
  readPlacement,
  type Placement,
} from "./placement.js";

describe("placement — pose ↔ Object3D ↔ feature round-trips (FR-11)", () => {
  const sample: Placement = { tx: 0.01, ty: -0.02, tz: 0.03, rx: 0.3, ry: -0.4, rz: 0.5 };

  it("applyPlacement then readPlacement round-trips a pose", () => {
    const obj = new THREE.Object3D();
    applyPlacement(obj, sample);
    const back = readPlacement(obj);
    for (const k of ["tx", "ty", "tz", "rx", "ry", "rz"] as const) {
      expect(back[k]).toBeCloseTo(sample[k], 9);
    }
  });

  it("the group ends at the placement's translation", () => {
    const obj = new THREE.Object3D();
    applyPlacement(obj, sample);
    expect(obj.position.toArray()).toEqual([0.01, -0.02, 0.03]);
  });

  it("placementFromFeature reads params with identity defaults", () => {
    expect(placementFromFeature(undefined)).toEqual(IDENTITY_PLACEMENT);
    const f: EditorFeature = { id: "f1", type: PLACEMENT_TYPE, params: { tx: 0.5, rz: 1 } };
    expect(placementFromFeature(f)).toEqual({ tx: 0.5, ty: 0, tz: 0, rx: 0, ry: 0, rz: 1 });
  });

  it("placementParams is the flat param record a feature stores", () => {
    expect(placementParams(sample)).toEqual(sample);
  });

  it("findPlacement returns the single placement feature", () => {
    const feats: EditorFeature[] = [
      { id: "f1", type: "box", params: { dx: 1 } },
      { id: "f2", type: PLACEMENT_TYPE, params: { tx: 0.1 } },
    ];
    expect(findPlacement(feats)?.id).toBe("f2");
    expect(findPlacement([feats[0]!])).toBeUndefined();
  });
});

describe("placement — pure Euler↔quaternion vs THREE ground truth (§2.11.1)", () => {
  // A spread of angle triples, including each axis alone, combinations, and the
  // ry = ±π/2 gimbal-lock branch quatToEulerXYZ special-cases.
  const TRIPLES: Array<[number, number, number]> = [
    [0, 0, 0],
    [0.3, 0, 0],
    [0, -0.4, 0],
    [0, 0, 0.5],
    [0.3, -0.4, 0.5],
    [-1.2, 0.7, 2.9],
    [Math.PI / 2, -Math.PI / 3, Math.PI / 4],
    [0.2, Math.PI / 2, 0.6], // gimbal lock +
    [0.2, -Math.PI / 2, 0.6], // gimbal lock −
  ];

  it("eulerXYZQuat matches THREE.Quaternion.setFromEuler(..., 'XYZ') exactly", () => {
    for (const [rx, ry, rz] of TRIPLES) {
      const three = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "XYZ"));
      const [x, y, z, w] = eulerXYZQuat(rx, ry, rz);
      expect(x).toBeCloseTo(three.x, 12);
      expect(y).toBeCloseTo(three.y, 12);
      expect(z).toBeCloseTo(three.z, 12);
      expect(w).toBeCloseTo(three.w, 12);
    }
  });

  it("quatToEulerXYZ matches THREE.Euler.setFromQuaternion(q, 'XYZ') exactly", () => {
    for (const [rx, ry, rz] of TRIPLES) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "XYZ"));
      const ours = quatToEulerXYZ([q.x, q.y, q.z, q.w]);
      const three = new THREE.Euler().setFromQuaternion(q, "XYZ");
      expect(ours[0]).toBeCloseTo(three.x, 9);
      expect(ours[1]).toBeCloseTo(three.y, 9);
      expect(ours[2]).toBeCloseTo(three.z, 9);
    }
  });

  it("isIdentityPlacement is true only for the exact identity", () => {
    expect(isIdentityPlacement(IDENTITY_PLACEMENT)).toBe(true);
    expect(isIdentityPlacement({ ...IDENTITY_PLACEMENT, tz: 0.5 })).toBe(false);
    expect(isIdentityPlacement({ ...IDENTITY_PLACEMENT, ry: -0.1 })).toBe(false);
  });

  it("placementPoseOf: identity pose without a placement, composed pose with one", () => {
    const none = placementPoseOf([{ id: "f1", type: "box", params: { dx: 1 } }]);
    expect(none.position).toEqual([0, 0, 0]);
    expect(none.orientation).toEqual([0, 0, 0, 1]);

    const posed = placementPoseOf([
      { id: "f1", type: "box", params: { dx: 1 } },
      { id: "f2", type: PLACEMENT_TYPE, params: { tx: 0.1, tz: 0.5, rx: 0.3, rz: -0.7 } },
    ]);
    expect(posed.position).toEqual([0.1, 0, 0.5]);
    const three = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, -0.7, "XYZ"));
    expect(posed.orientation[0]).toBeCloseTo(three.x, 12);
    expect(posed.orientation[1]).toBeCloseTo(three.y, 12);
    expect(posed.orientation[2]).toBeCloseTo(three.z, 12);
    expect(posed.orientation[3]).toBeCloseTo(three.w, 12);
  });
});
