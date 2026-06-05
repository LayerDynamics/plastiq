// Revolve feature (SPEC-4 FR-5): a solid by revolving a sketch profile about an
// axis through an angle, via OCCT BRepPrimAPI_MakeRevol.

import { normalize, type Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import type { Sketch } from "../sketch/sketch.js";
import { Solid } from "../solid/solid.js";

/**
 * Revolve `sketch` about the axis (`axisOrigin`, `axisDir`) by `angle` radians
 * (e.g. 2π for a full revolution). The profile should touch/border the axis for
 * a closed solid.
 */
export function revolve(
  oc: Occt,
  sketch: Sketch,
  axisOrigin: Vec3,
  axisDir: Vec3,
  angle: number,
): Solid {
  const face = sketch.toFace(oc);
  const [ox, oy, oz] = axisOrigin;
  const [dx, dy, dz] = normalize(axisDir);
  const pnt = new oc.gp_Pnt_3(ox, oy, oz);
  const dir = new oc.gp_Dir_4(dx, dy, dz);
  const axis = new oc.gp_Ax1_2(pnt, dir);
  const revol = new oc.BRepPrimAPI_MakeRevol_1(face, axis, angle, false);
  try {
    return new Solid(oc, revol.Shape());
  } finally {
    revol.delete();
    axis.delete();
    dir.delete();
    pnt.delete();
    face.delete();
  }
}
