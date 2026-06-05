// The model origin (SPEC-4 FR-18): the global reference frame every datum and
// component is ultimately placed relative to.

import type { Vec3 } from "../math/index.js";

export interface Origin {
  readonly point: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

/** The canonical world origin at (0,0,0) with the standard right-handed axes. */
export const GLOBAL_ORIGIN: Origin = {
  point: [0, 0, 0],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};
