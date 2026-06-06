// Exploded assembly view (FR-33 family): spread the instances apart so the user
// can see how they fit together, without touching the document. Pure transform on
// the render poses; the Viewport applies it before handing instances to the scene.

import type { Quat, Vec3 } from "../assembly/model.js";

export interface RenderInstance {
  id: string;
  position: Vec3;
  orientation: Quat;
}

/**
 * Move each instance radially away from the assembly centroid by `factor` of its
 * offset from that centroid. `factor = 0` → assembled (unchanged); `factor = 1` →
 * the spread from the centre doubles; larger → further apart. Orientation is never
 * touched, and a lone instance (which IS the centroid) can't move. Pure: the input
 * is not mutated.
 */
export function explodeInstances(
  instances: readonly RenderInstance[],
  factor: number,
): RenderInstance[] {
  const n = instances.length;
  if (n === 0) return [];
  const c: Vec3 = [0, 0, 0];
  for (const i of instances) {
    c[0] += i.position[0];
    c[1] += i.position[1];
    c[2] += i.position[2];
  }
  c[0] /= n;
  c[1] /= n;
  c[2] /= n;
  const f = Math.max(0, factor);
  return instances.map((i) => ({
    id: i.id,
    orientation: [...i.orientation] as Quat,
    position: [
      i.position[0] + (i.position[0] - c[0]) * f,
      i.position[1] + (i.position[1] - c[1]) * f,
      i.position[2] + (i.position[2] - c[2]) * f,
    ] as Vec3,
  }));
}
