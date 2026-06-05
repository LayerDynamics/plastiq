// Joint lowering — map the assembly's articulated joints to manifest constraints.
// Only the kinds the physics layer supports (revolute → hinge, fixed → fixed) are
// lowerable; the rest are reported as skipped by the caller.

import type { Vec3 } from "../math/index.js";
import type { JointKind } from "../assembly/solver.js";
import type { ManifestConstraint } from "./manifest.js";

export interface Joint {
  readonly kind: JointKind;
  readonly origin: Vec3;
  readonly axis: Vec3;
}

/**
 * Build a joint frame. `parentIndex`/`childIndex` are accepted for API symmetry
 * with the editor but the lowered constraint keys off body names + the frame.
 */
export function makeJoint(
  kind: JointKind,
  _parentIndex: number,
  _childIndex: number,
  frame: { origin: Vec3; axis: Vec3 },
): Joint {
  return { kind, origin: frame.origin, axis: frame.axis };
}

/** Whether a joint kind has a physics-layer (hinge/fixed) equivalent. */
export function isLowerable(kind: JointKind): boolean {
  return kind === "revolute" || kind === "fixed";
}

export interface JointBinding {
  joint: Joint;
  bodyA: string;
  bodyB: string;
}

/** Lower the bound joints to manifest constraints (assumes all are lowerable). */
export function lowerJoints(bindings: JointBinding[]): ManifestConstraint[] {
  return bindings.map((b) => ({
    kind: b.joint.kind === "revolute" ? "hinge" : "fixed",
    bodyA: b.bodyA,
    bodyB: b.bodyB,
    origin: [b.joint.origin[0], b.joint.origin[1], b.joint.origin[2]],
    axis: [b.joint.axis[0], b.joint.axis[1], b.joint.axis[2]],
  }));
}
