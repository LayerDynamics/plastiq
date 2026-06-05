// Component placement (SPEC-4 FR-21): a rigid transform (position + orientation)
// composed down the component tree to give each body its world pose.

import { add, quatMul, quatNormalize, quatRotate, type Quat, type Vec3 } from "../math/index.js";

export interface Placement {
  readonly position: Vec3;
  readonly orientation: Quat;
}

export const IDENTITY_PLACEMENT: Placement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };

/**
 * Compose a child placement under a parent: world = parent ∘ child. The child's
 * position is rotated by the parent orientation then offset by the parent
 * position; orientations multiply.
 */
export function composePlacement(parent: Placement, child: Placement): Placement {
  return {
    position: add(parent.position, quatRotate(parent.orientation, child.position)),
    orientation: quatNormalize(quatMul(parent.orientation, child.orientation)),
  };
}
