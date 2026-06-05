// Primitive solids (SPEC-4 Task 0.6). Dimensions are SI metres — the kernel
// treats the OCCT modelling unit as the metre, so mass properties come out in
// SI directly (no mm↔m rescale inside the engine; unit conversion happens at the
// authoring input boundary, src/unit).

import type { Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import { Solid } from "./solid.js";

/** Axis-aligned box with one corner at the origin and the given SI dimensions. */
export function makeBox(oc: Occt, dx: number, dy: number, dz: number): Solid {
  const mk = new oc.BRepPrimAPI_MakeBox_2(dx, dy, dz);
  try {
    // .Solid() returns a ref-counted handle that outlives the builder.
    return new Solid(oc, mk.Solid());
  } finally {
    mk.delete();
  }
}

/** Axis-aligned box with one corner at `corner` (SI) and the given SI dimensions. */
export function makeBoxAt(oc: Occt, corner: Vec3, dx: number, dy: number, dz: number): Solid {
  const pnt = new oc.gp_Pnt_3(corner[0], corner[1], corner[2]);
  const mk = new oc.BRepPrimAPI_MakeBox_3(pnt, dx, dy, dz);
  try {
    return new Solid(oc, mk.Solid());
  } finally {
    mk.delete();
    pnt.delete();
  }
}

/** Sphere of SI `radius`, centred at `center` (default origin). */
export function makeSphere(oc: Occt, radius: number, center: Vec3 = [0, 0, 0]): Solid {
  const pnt = new oc.gp_Pnt_3(center[0], center[1], center[2]);
  const mk = new oc.BRepPrimAPI_MakeSphere_5(pnt, radius);
  try {
    return new Solid(oc, mk.Solid());
  } finally {
    mk.delete();
    pnt.delete();
  }
}
