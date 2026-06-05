// Tangency residual (SPEC-4 FR-27). A cylinder/sphere on component A is tangent
// to a planar face on component B when the entity's reference point sits exactly
// `radius` from the plane, on its positive-normal side. For a cylinder the axis
// must additionally be parallel to the plane (the axis direction perpendicular
// to the plane normal); a sphere carries no axis and contributes only the
// distance row.

import { dot, sub } from "../math/index.js";
import type { WorldRef } from "./constraint.js";

/**
 * Residual for "`a` tangent to plane `b` at offset `radius`".
 *
 * `a.point` is the cylinder-axis point or sphere centre (world); `a.dir` is the
 * cylinder axis (or a zero vector for a sphere). `b.point`/`b.dir` are a point
 * on the plane and its unit normal (world).
 *   row 0: signed distance from `a.point` to the plane − radius = 0.
 *   row 1 (cylinders only): axis · normal = 0 (axis lies parallel to the face).
 */
export function tangentResidual(a: WorldRef, b: WorldRef, radius: number): number[] {
  const signedDistance = dot(sub(a.point, b.point), b.dir);
  const rows = [signedDistance - radius];
  const axisLen = Math.hypot(a.dir[0], a.dir[1], a.dir[2]);
  if (axisLen > 1e-9) {
    rows.push(dot(a.dir, b.dir));
  }
  return rows;
}
