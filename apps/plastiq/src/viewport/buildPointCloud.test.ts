// buildPointCloud (SPEC-13) — the point-cloud render primitive. Pure THREE object construction, so
// it verifies in Node with no WebGL context: position + per-point color attributes, the vertexColors
// material, and the uniform-colour fallback when a cloud carries no colours.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildPointCloud, POINT_CLOUD_COLOR } from "./buildPointCloud.js";
import type { PointCloudDoc } from "../store/types.js";

const base = (over: Partial<PointCloudDoc> = {}): PointCloudDoc => ({
  kind: "pointcloud",
  points: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  source: { mode: "import", providerId: "test" },
  ...over,
});

describe("buildPointCloud", () => {
  it("builds a THREE.Points with a position attribute of the cloud's XYZ triples", () => {
    const built = buildPointCloud(base());
    expect(built.count).toBe(3);
    const pos = (built.points.geometry as THREE.BufferGeometry).getAttribute("position");
    expect(pos.count).toBe(3);
    expect(Array.from(pos.array)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    built.dispose();
  });

  it("uses per-point colours when present and length-matched", () => {
    const built = buildPointCloud(base({ colors: [1, 0, 0, 0, 1, 0, 0, 0, 1] }));
    const col = (built.points.geometry as THREE.BufferGeometry).getAttribute("color");
    expect(Array.from(col.array)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const mat = built.points.material as THREE.PointsMaterial;
    expect(mat.vertexColors).toBe(true);
    built.dispose();
  });

  it("falls back to the uniform colour when colours are absent or mismatched", () => {
    const expected = new THREE.Color(POINT_CLOUD_COLOR);
    for (const doc of [base(), base({ colors: [1, 0, 0] /* wrong length */ })]) {
      const built = buildPointCloud(doc);
      const col = (built.points.geometry as THREE.BufferGeometry).getAttribute("color");
      expect(col.count).toBe(3);
      // every point took the fallback colour
      for (let i = 0; i < 3; i++) {
        expect(col.getX(i)).toBeCloseTo(expected.r);
        expect(col.getY(i)).toBeCloseTo(expected.g);
        expect(col.getZ(i)).toBeCloseTo(expected.b);
      }
      built.dispose();
    }
  });
});
