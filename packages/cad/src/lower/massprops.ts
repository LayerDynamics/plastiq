// Mass properties from the exact B-rep (SPEC-4 Task 0.6 / FR-25).
//
// Computes volume, mass (= density × volume), centre of mass, and the
// body-frame inertia tensor (about the COM) in SI, matching mechx_sim's
// RigidBody conventions (SPEC-3 FR-4/FR-10). OCCT's GProp returns the inertia
// about the reference origin for a unit-density solid; we shift it to the COM
// via the (reverse) parallel-axis theorem and scale by density.

import type { Mat3, Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
// MassProperties is part of the frozen SimManifest contract — single source of
// truth in manifest.ts. This module computes it; it does not redeclare it.
import type { MassProperties } from "./manifest.js";

export type { MassProperties };

export function massProperties(oc: Occt, solid: Solid, density: number): MassProperties {
  const props = new oc.GProp_GProps_1();
  try {
    // Exact volume integration over the B-rep (no triangulation).
    oc.BRepGProp.VolumeProperties_1(solid.shape, props, true, false, false);

    const volume = props.Mass(); // unit-density "mass" == volume
    const mass = density * volume;

    const c = props.CentreOfMass();
    const com: Vec3 = [c.X(), c.Y(), c.Z()];
    c.delete();

    // OCCT's GProp MatrixOfInertia for VolumeProperties is taken about the
    // centre of mass (verified against the analytic offset box), at unit
    // density. Scale by density to get the SI body-frame inertia tensor.
    const mat = props.MatrixOfInertia();
    const v = (r: number, col: number): number => density * mat.Value(r, col);
    const inertia: Mat3 = [
      v(1, 1),
      v(1, 2),
      v(1, 3),
      v(2, 1),
      v(2, 2),
      v(2, 3),
      v(3, 1),
      v(3, 2),
      v(3, 3),
    ];
    mat.delete();

    return { volume, mass, com, inertia };
  } finally {
    props.delete();
  }
}
