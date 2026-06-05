// Articulated joints (SPEC-4 FR-28). A `Joint` couples a parent and child
// component through a joint frame (an origin + a primary axis) and a kind that
// fixes which degrees of freedom remain free. Optional limits bound the joint's
// coordinate(s). This is the kinematic data model; the sim lowering (Task 4.4)
// maps the subset with direct sim-joint equivalents onto mechx_sim joints.

import { type Vec3 } from "../math/index.js";

export type JointKind =
  | "revolute" // 1 rotational DOF about `axis`
  | "prismatic" // 1 translational DOF along `axis`
  | "cylindrical" // rotate about + slide along `axis` (1R + 1T)
  | "ball" // 3 rotational DOF (spherical)
  | "planar" // slide in the plane ⟂ `axis` + spin about it (2T + 1R)
  | "fixed"; // 0 DOF (weld)

export const JOINT_KINDS: readonly JointKind[] = [
  "revolute",
  "prismatic",
  "cylindrical",
  "ball",
  "planar",
  "fixed",
];

/** The joint's frame: an origin and a primary axis, in world coordinates. */
export interface JointFrame {
  readonly origin: Vec3;
  /** Primary axis: rotation axis (revolute/cylindrical), slide axis
   * (prismatic), or plane normal (planar). Should be unit length. */
  readonly axis: Vec3;
}

/** Bounds on a joint's primary coordinate (radians for angular, metres for linear). */
export interface JointLimits {
  readonly lower?: number;
  readonly upper?: number;
}

export interface Joint {
  readonly kind: JointKind;
  /** Parent component index (the base side of the joint). */
  readonly parent: number;
  /** Child component index (the moving side). */
  readonly child: number;
  readonly frame: JointFrame;
  readonly limits?: JointLimits;
}

/** Degrees of freedom a joint kind leaves free, split by type. */
export interface JointDof {
  readonly translational: number;
  readonly rotational: number;
}

/** The free DOF (translational + rotational) for a joint kind. */
export function jointDof(kind: JointKind): JointDof {
  switch (kind) {
    case "revolute":
      return { translational: 0, rotational: 1 };
    case "prismatic":
      return { translational: 1, rotational: 0 };
    case "cylindrical":
      return { translational: 1, rotational: 1 };
    case "ball":
      return { translational: 0, rotational: 3 };
    case "planar":
      return { translational: 2, rotational: 1 };
    case "fixed":
      return { translational: 0, rotational: 0 };
  }
}

/** Total free DOF count for a joint kind. */
export function jointDofCount(kind: JointKind): number {
  const d = jointDof(kind);
  return d.translational + d.rotational;
}

/**
 * Clamp a joint coordinate to its limits. A missing bound is unbounded; throws
 * if the limits are inverted (lower > upper), which is an authoring error.
 */
export function applyJointLimits(joint: Joint, coordinate: number): number {
  const { lower, upper } = joint.limits ?? {};
  if (lower !== undefined && upper !== undefined && lower > upper) {
    throw new Error(`joint limits inverted: lower ${lower} > upper ${upper}`);
  }
  let v = coordinate;
  if (lower !== undefined) v = Math.max(v, lower);
  if (upper !== undefined) v = Math.min(v, upper);
  return v;
}

/** True if `coordinate` is within the joint's limits (inclusive). */
export function withinJointLimits(joint: Joint, coordinate: number): boolean {
  const { lower, upper } = joint.limits ?? {};
  if (lower !== undefined && coordinate < lower) return false;
  if (upper !== undefined && coordinate > upper) return false;
  return true;
}

export function makeJoint(
  kind: JointKind,
  parent: number,
  child: number,
  frame: JointFrame,
  limits?: JointLimits,
): Joint {
  return { kind, parent, child, frame, limits };
}
