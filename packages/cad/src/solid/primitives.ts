// B-rep primitive solids on OCCT.

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "./solid.js";

/** An axis-aligned box of size dx×dy×dz (SI metres) with a corner at the origin. */
export function makeBox(oc: Occt, dx: number, dy: number, dz: number): Solid {
  const maker = new oc.BRepPrimAPI_MakeBox_2(dx, dy, dz);
  const solid = maker.Solid();
  maker.delete();
  return new Solid(oc, solid);
}

/** An axis-aligned box of size dx×dy×dz with its minimum corner at `corner`. */
export function makeBoxAt(
  oc: Occt,
  corner: Vec3,
  dx: number,
  dy: number,
  dz: number,
): Solid {
  const p = new oc.gp_Pnt_3(corner[0], corner[1], corner[2]);
  const maker = new oc.BRepPrimAPI_MakeBox_3(p, dx, dy, dz);
  const solid = maker.Solid();
  maker.delete();
  p.delete();
  return new Solid(oc, solid);
}
