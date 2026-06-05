// Body (SPEC-4 FR-20): a single contiguous geometry leaf — the unit that becomes
// exactly one mechx_sim RigidBody at lowering. A body carries its geometry, a
// material reference, and (once finalized) its computed mass properties.
//
// The component/body distinction (FR-21): COMPONENTS organize and position
// (a tree of placements); BODIES hold geometry and become rigid bodies. A
// component is never itself a rigid body — its bodies are.

import type { MassProperties } from "../lower/manifest.js";
import type { Solid } from "../solid/solid.js";

export interface Body {
  readonly name: string;
  /** The B-rep geometry (attached once modelled). */
  geometry?: Solid;
  /** Material name, resolved via the material manager at lowering (FR-22). */
  material?: string;
  /** Computed mass properties (set when geometry + material are finalized). */
  massProps?: MassProperties;
}

export function makeBody(name: string, material?: string): Body {
  return { name, material };
}
