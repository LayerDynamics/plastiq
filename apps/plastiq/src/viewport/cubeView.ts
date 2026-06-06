// View-cube directions (SPEC-5 FR-12). A clickable view cube snaps the camera to
// 26 canonical orientations: 6 faces (one axis), 12 edges (two axes) and 8
// corners (three axes). The camera direction (target → camera) is the outward
// normal of the clicked region. Z-up CAD frame, matching views.ts. Pure data +
// lookups, unit-tested without a renderer.

import * as THREE from "three";

export type CubeKind = "face" | "edge" | "corner";

/** A signed axis triple; each component ∈ {−1,0,1}, not all zero. */
export type CubeAxes = readonly [number, number, number];

export interface CubeRegion {
  id: string;
  kind: CubeKind;
  axes: CubeAxes;
}

// Per-axis labels (z,y,x order): top/bottom, back/front, right/left.
function label(axes: CubeAxes): string {
  const [x, y, z] = axes;
  let s = "";
  if (z > 0) s += "T";
  else if (z < 0) s += "Bo";
  if (y > 0) s += "Bk";
  else if (y < 0) s += "F";
  if (x > 0) s += "R";
  else if (x < 0) s += "L";
  return s;
}

function kindOf(axes: CubeAxes): CubeKind {
  const n = axes.filter((c) => c !== 0).length;
  return n === 1 ? "face" : n === 2 ? "edge" : "corner";
}

/** All 26 cube regions (6 faces + 12 edges + 8 corners), deterministic order. */
export const CUBE_REGIONS: CubeRegion[] = (() => {
  const out: CubeRegion[] = [];
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if (x === 0 && y === 0 && z === 0) continue;
        const axes: CubeAxes = [x, y, z];
        out.push({ id: label(axes), kind: kindOf(axes), axes });
      }
    }
  }
  return out;
})();

/** Camera direction (target → camera) for a cube region — the region's normal. */
export function cubeDirection(axes: CubeAxes): THREE.Vector3 {
  return new THREE.Vector3(axes[0], axes[1], axes[2]).normalize();
}

/** Look up a region by id (e.g. "T", "TR", "TFR"). */
export function cubeRegion(id: string): CubeRegion | undefined {
  return CUBE_REGIONS.find((r) => r.id === id);
}
