import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { EditorFeature } from "../store/types.js";
import {
  applyPlacement,
  findPlacement,
  IDENTITY_PLACEMENT,
  placementFromFeature,
  placementParams,
  PLACEMENT_TYPE,
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
