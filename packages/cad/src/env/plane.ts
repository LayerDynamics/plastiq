// Datum planes — the parametric reference frames sketches are drawn on.
//
// A DatumPlane is pure data: an origin plus an orthonormal (normal, xAxis) frame
// in SI metres. The in-plane Y axis is normal × xAxis. Sketch 2D coordinates
// (u along xAxis, v along yAxis) map to 3D via origin + u·xAxis + v·yAxis.

import type { Vec3 } from "../math/index.js";
import { add, cross, dot, scale, sub } from "../math/index.js";

export interface DatumPlane {
  readonly origin: Vec3;
  /** Unit plane normal. */
  readonly normal: Vec3;
  /** Unit in-plane X axis. */
  readonly xAxis: Vec3;
}

/** The world XY plane (normal +Z, x axis +X). */
export function planeXY(): DatumPlane {
  return { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] };
}

/** The world XZ plane (normal +Y). */
export function planeXZ(): DatumPlane {
  return { origin: [0, 0, 0], normal: [0, 1, 0], xAxis: [1, 0, 0] };
}

/** The world YZ plane (normal +X). */
export function planeYZ(): DatumPlane {
  return { origin: [0, 0, 0], normal: [1, 0, 0], xAxis: [0, 1, 0] };
}

/** A copy of `plane` translated `distance` (SI metres) along its normal. */
export function offsetPlane(plane: DatumPlane, distance: number): DatumPlane {
  return { ...plane, origin: add(plane.origin, scale(plane.normal, distance)) };
}

/** The in-plane Y axis (normal × xAxis), unit length for an orthonormal frame. */
export function planeYAxis(plane: DatumPlane): Vec3 {
  return cross(plane.normal, plane.xAxis);
}

/** Map a 2D sketch coordinate (u along xAxis, v along yAxis) to a 3D point. */
export function planePointToWorld(plane: DatumPlane, u: number, v: number): Vec3 {
  const y = planeYAxis(plane);
  return add(plane.origin, add(scale(plane.xAxis, u), scale(y, v)));
}

/**
 * Project a world point into the plane's (u, v) frame.
 *
 * `height` is the signed distance along the plane normal (0 when on-plane).
 * Off-plane points still yield their planar components — the orthogonal
 * projection onto the plane.
 */
export function worldPointToPlane(
  plane: DatumPlane,
  p: Vec3,
): { u: number; v: number; height: number } {
  const d = sub(p, plane.origin);
  const y = planeYAxis(plane);
  return {
    u: dot(d, plane.xAxis),
    v: dot(d, y),
    height: dot(d, plane.normal),
  };
}
