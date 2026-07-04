// Joint lowering — map the assembly's articulated joints to manifest constraints.
// Every JointKind now has a physics-layer equivalent: revolute → hinge,
// prismatic → slider, cylindrical → cylindrical, ball → ball, planar → planar,
// fixed → fixed. (isLowerable remains the guard point should a future JointKind
// arrive without a manifest constraint to lower to.)

import type { Vec3 } from "../math/index.js";
import type { JointKind } from "../assembly/solver.js";
import type { ManifestConstraint, ManifestConstraintKind } from "./manifest.js";

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

/** The manifest constraint kind each assembly joint kind lowers to. */
const LOWERED_KIND: Record<JointKind, ManifestConstraintKind> = {
  revolute: "hinge",
  prismatic: "slider",
  cylindrical: "cylindrical",
  ball: "ball",
  planar: "planar",
  fixed: "fixed",
};

/** Whether a joint kind has a physics-layer equivalent. Every current JointKind
 * does; this stays as the extension point for any future kind that does not. */
export function isLowerable(kind: JointKind): boolean {
  return kind in LOWERED_KIND;
}

export interface JointBinding {
  joint: Joint;
  bodyA: string;
  bodyB: string;
}

/** Lower the bound joints to manifest constraints (assumes all are lowerable). */
export function lowerJoints(bindings: JointBinding[]): ManifestConstraint[] {
  return bindings.map((b) => ({
    kind: LOWERED_KIND[b.joint.kind],
    bodyA: b.bodyA,
    bodyB: b.bodyB,
    origin: [b.joint.origin[0], b.joint.origin[1], b.joint.origin[2]],
    axis: [b.joint.axis[0], b.joint.axis[1], b.joint.axis[2]],
  }));
}
