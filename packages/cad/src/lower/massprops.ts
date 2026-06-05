// Mass properties of a solid at a given material density.

import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";

export interface MassProperties {
  /** Mass in kg. */
  mass: number;
  /** Volume in m³. */
  volume: number;
  /** Centre of mass (geometric centroid) in local SI metres. */
  com: [number, number, number];
}

/** Compute a solid's mass properties at the given density (kg/m³). */
export function massProperties(_oc: Occt, solid: Solid, density: number): MassProperties {
  const volume = solid.volume();
  const com = solid.centreOfMass();
  return { mass: volume * density, volume, com };
}
