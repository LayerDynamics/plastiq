// Standard camera views (SPEC-5 FR-12). In the Z-up CAD/sim frame, each named
// view is the unit direction FROM the look-at target TO the camera. Pure data +
// a pure lookup, so it unit-tests without a renderer.

import * as THREE from "three";

export type StandardView = "top" | "bottom" | "front" | "back" | "right" | "left" | "iso";

const ISO = 1 / Math.sqrt(3);

/** Direction from target → camera for each standard view (Z-up). */
const DIRECTIONS: Record<StandardView, readonly [number, number, number]> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  iso: [ISO, -ISO, ISO],
};

/** Unit camera direction for a standard view. */
export function standardViewDirection(view: StandardView): THREE.Vector3 {
  const d = DIRECTIONS[view];
  return new THREE.Vector3(d[0], d[1], d[2]);
}
