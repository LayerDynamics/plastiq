// Datum planes (SPEC-4 FR-18): the surfaces sketches and features attach to. A
// plane carries an origin + an orthonormal (u, v, normal) frame so a 2D sketch
// coordinate maps unambiguously to a 3D world point. Pure f64 data — OCCT is
// only consulted when a sketch on the plane is turned into geometry.

import {
  add,
  cross,
  normalize,
  quatFromAxisAngle,
  quatRotate,
  scale,
  sub,
  type Vec3,
} from "../math/index.js";

export interface DatumPlane {
  readonly origin: Vec3;
  /** Unit plane normal. */
  readonly normal: Vec3;
  /** Unit in-plane axis (sketch +u). */
  readonly uAxis: Vec3;
  /** Unit in-plane axis (sketch +v) = normal × uAxis. */
  readonly vAxis: Vec3;
}

/** The standard XY datum (normal +Z). */
export function planeXY(): DatumPlane {
  return { origin: [0, 0, 0], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
}

/** The standard YZ datum (normal +X). */
export function planeYZ(): DatumPlane {
  return { origin: [0, 0, 0], normal: [1, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };
}

/** The standard ZX datum (normal +Y). */
export function planeZX(): DatumPlane {
  return { origin: [0, 0, 0], normal: [0, 1, 0], uAxis: [0, 0, 1], vAxis: [1, 0, 0] };
}

/** A plane parallel to `base`, offset by `distance` along its normal. */
export function offsetPlane(base: DatumPlane, distance: number): DatumPlane {
  return { ...base, origin: add(base.origin, scale(base.normal, distance)) };
}

/**
 * The plane through three non-collinear points: origin `a`, `uAxis` toward `b`,
 * normal = (b−a)×(c−a). Throws if the points are collinear (degenerate).
 */
export function planeThroughPoints(a: Vec3, b: Vec3, c: Vec3): DatumPlane {
  const uAxis = normalize(sub(b, a));
  const normal = normalize(cross(sub(b, a), sub(c, a)));
  const vAxis = cross(normal, uAxis); // unit: normal ⟂ uAxis, both unit
  return { origin: a, normal, uAxis, vAxis };
}

/** `base` tilted by `angle` (radians) about its uAxis (a hinge along +u). */
export function tiltedPlane(base: DatumPlane, angle: number): DatumPlane {
  const q = quatFromAxisAngle(base.uAxis, angle);
  return {
    origin: base.origin,
    uAxis: base.uAxis,
    normal: quatRotate(q, base.normal),
    vAxis: quatRotate(q, base.vAxis),
  };
}

/** Map a 2D sketch coordinate (u, v) on `plane` to a 3D world point. */
export function pointOnPlane(plane: DatumPlane, u: number, v: number): Vec3 {
  return add(plane.origin, add(scale(plane.uAxis, u), scale(plane.vAxis, v)));
}
