// Assembly→sim joint lowering (SPEC-4 FR-30, decision Q8). Maps the kinematic
// assembly Joints (FR-28) onto the SimManifest's LoweredConstraint vocabulary,
// which mirrors the mechx_sim M5 joint set (hinge / fixed / distance / spring).
//
// Q8 mapping (recorded here):
//   revolute   → hinge       (1 rotational DOF about the axis)
//   fixed      → fixed       (weld, 0 DOF)   — also how a rigid group lowers
//   ball / prismatic / cylindrical / planar → NO direct mechx_sim equivalent.
//     The M5 joint set is {hinge, fixed, distance, spring}; its `distance` joint
//     locks only ONE DOF (the radial separation), so it cannot express a
//     spherical/ball joint (3 anchor DOF locked, 3 rotational free) — `point_lock`
//     (the full 3-DOF coincidence) is only reachable inside hinge/fixed. There is
//     likewise no slider (prismatic). So these kinds are NOT lowered in V1;
//     lowering one throws a typed error. (Sim-side ball/prismatic joints are a
//     documented SPEC-3 follow-on / TODO, R6.) A four-bar (all-revolute) lowers
//     fully; a slider-crank's prismatic does not in V1.
//
// NOTE: a distance-MATE (a rigid rod at a fixed length) still lowers to the
// `distance` constraint — that is exactly the 1-DOF the sim's Distance models.
//
// The assembly Joint's `frame` (origin + axis) is in WORLD coordinates; the
// lowered constraint carries the world anchor/axis, and the Rust bridge converts
// them to each body's local frame at ingest using the spawned bodies' poses.

import { normalize } from "../math/index.js";
import type { Joint } from "../assembly/joint.js";
import type { LoweredConstraint } from "./manifest.js";

/** One joint plus the resolved manifest body names of its parent/child. */
export interface JointBinding {
  readonly joint: Joint;
  /** Manifest body name for `joint.parent`. */
  readonly bodyA: string;
  /** Manifest body name for `joint.child`. */
  readonly bodyB: string;
}

/** True if a joint kind can be lowered to the V1 sim joint vocabulary. */
export function isLowerable(kind: Joint["kind"]): boolean {
  return kind === "revolute" || kind === "fixed";
}

/** Lower one bound joint to a manifest constraint (throws for unsupported kinds). */
export function lowerJoint(binding: JointBinding): LoweredConstraint {
  const { joint, bodyA, bodyB } = binding;
  switch (joint.kind) {
    case "revolute":
      return {
        kind: "hinge",
        bodyA,
        bodyB,
        anchor: joint.frame.origin,
        axis: normalize(joint.frame.axis),
      };
    case "fixed":
      return { kind: "fixed", bodyA, bodyB };
    case "ball":
    case "prismatic":
    case "cylindrical":
    case "planar":
      // No mechx_sim equivalent in V1 (Q8): the sim's `distance` locks only the
      // radial DOF, so it is NOT a ball joint, and there is no slider.
      throw new Error(
        `joint kind '${joint.kind}' has no mechx_sim equivalent (Q8); not lowered in V1`,
      );
  }
}

/** Lower a set of bound joints; unsupported kinds throw (see Q8). */
export function lowerJoints(bindings: readonly JointBinding[]): LoweredConstraint[] {
  return bindings.map(lowerJoint);
}
