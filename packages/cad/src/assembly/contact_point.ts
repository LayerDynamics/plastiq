// Contact points (SPEC-4 FR-29). A `ContactPoint` marks a place where two
// components are intended to touch — a connector with a local point on each
// component. Given the components' world poses it resolves the two points to
// world and reports the gap (separation), the input a contact-driven mate or a
// sim contact uses.

import { add, length, quatRotate, sub, type Vec3 } from "../math/index.js";
import type { ComponentPose } from "./solver.js";

export interface ContactPoint {
  /** Component index carrying `pointA`. */
  readonly a: number;
  /** Component index carrying `pointB`. */
  readonly b: number;
  /** Local contact point on component `a`. */
  readonly pointA: Vec3;
  /** Local contact point on component `b`. */
  readonly pointB: Vec3;
}

/** Resolve a local point on a posed component to world. */
function worldPoint(pose: ComponentPose, local: Vec3): Vec3 {
  return add(pose.position, quatRotate(pose.orientation, local));
}

/** World position of `pointA` under the given pose. */
export function contactWorldA(cp: ContactPoint, poseA: ComponentPose): Vec3 {
  return worldPoint(poseA, cp.pointA);
}

/** World position of `pointB` under the given pose. */
export function contactWorldB(cp: ContactPoint, poseB: ComponentPose): Vec3 {
  return worldPoint(poseB, cp.pointB);
}

/** The separation (gap) between the two contact points in world; 0 = touching. */
export function contactGap(cp: ContactPoint, poseA: ComponentPose, poseB: ComponentPose): number {
  return length(sub(contactWorldA(cp, poseA), contactWorldB(cp, poseB)));
}
