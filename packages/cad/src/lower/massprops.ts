// Mass properties of a solid at a given material density.
//
// Closed solids use volume properties; open shells/faces (§14) have no enclosed
// volume, so we report surface area + surface COM and zero mass/volume until a
// sheet thickness is modeled (FablesFindings R8 / §14).

import type { Occt } from "../oc/init.js";
import { bodyKindOf, type BodyKind } from "../solid/bodyKind.js";
import type { Solid } from "../solid/solid.js";

export interface MassProperties {
  /** Mass in kg. */
  mass: number;
  /** Volume in m³. Zero for open shells/faces (no enclosed volume). */
  volume: number;
  /** Centre of mass (geometric centroid) in local SI metres. */
  com: [number, number, number];
  /**
   * Surface area in m² — set for shell/face bodies where volume is zero.
   * Optional so solid-only callers stay unchanged.
   */
  area?: number;
  /** Kind that selected the volume vs surface property path. */
  bodyKind?: BodyKind;
}

/** Compute a solid's mass properties at the given density (kg/m³). */
export function massProperties(oc: Occt, solid: Solid, density: number): MassProperties {
  const kind = bodyKindOf(oc, solid);
  // Open sheets: VolumeProperties is meaningless (or near-zero noise). Surface
  // props give real area + COM. Mass stays 0 without a modeled thickness —
  // density alone (kg/m³) cannot become sheet mass.
  if (kind === "shell" || kind === "face") {
    const props = new oc.GProp_GProps_1();
    try {
      oc.BRepGProp.SurfaceProperties_1(solid.shape, props, false, false);
      const area = props.Mass();
      const c = props.CentreOfMass();
      try {
        return {
          mass: 0,
          volume: 0,
          com: [c.X(), c.Y(), c.Z()],
          area,
          bodyKind: kind,
        };
      } finally {
        c.delete();
      }
    } finally {
      props.delete();
    }
  }
  const volume = solid.volume();
  const com = solid.centreOfMass();
  return { mass: volume * density, volume, com, bodyKind: kind };
}
