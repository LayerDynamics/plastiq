// PointCloudDoc → a renderable THREE.Points cloud (SPEC-13). This is the point-cloud sibling of
// buildMesh.ts's corner/vertex primitive: one BufferGeometry with a "position" attribute and a
// per-point "color" attribute driving a vertexColors PointsMaterial — the same technique the B-rep
// vertex markers and mesh-body vertices use, here for a whole dense cloud. Pure object construction
// (no WebGL context) so it unit-tests in Node.

import * as THREE from "three";
import type { PointCloudDoc } from "../store/types.js";

/** Uniform fallback colour when a cloud carries no per-point colours (a cool grey). */
export const POINT_CLOUD_COLOR = 0x9ab0c8;

export interface BuiltPointCloud {
  /** The renderable cloud, ready to add to the scene. */
  points: THREE.Points;
  /** Point count (position.length / 3). */
  count: number;
  /** Free its geometry + material. */
  dispose(): void;
}

/** Build a renderable point cloud from a PointCloudDoc. Per-point colours are used when present and
 * length-matched (RGB in 0..1); otherwise every point takes the uniform fallback colour. */
export function buildPointCloud(doc: PointCloudDoc): BuiltPointCloud {
  const count = Math.floor(doc.points.length / 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(doc.points), 3));

  const colors = new Float32Array(count * 3);
  if (doc.colors && doc.colors.length === count * 3) {
    colors.set(doc.colors);
  } else {
    const c = new THREE.Color(POINT_CLOUD_COLOR);
    for (let i = 0; i < count; i++) c.toArray(colors, i * 3);
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 3,
    sizeAttenuation: false,
    vertexColors: true,
  });
  const points = new THREE.Points(geom, material);
  points.name = "point-cloud";

  return {
    points,
    count,
    dispose() {
      geom.dispose();
      material.dispose();
    },
  };
}
