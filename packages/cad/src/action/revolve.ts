// Revolve a sketch profile about an axis.

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";

/**
 * Revolve a sketch profile by `angle` radians about the axis through `origin`
 * along `axis`. A full 2π revolution makes a closed solid of revolution.
 */
export function revolve(
  oc: Occt,
  sketch: Sketch,
  origin: Vec3,
  axis: Vec3,
  angle: number,
): Solid {
  // A zero revolution angle sweeps nothing — OCCT returns an invalid shape; reject.
  if (!Number.isFinite(angle) || angle === 0) {
    throw new Error("revolve: angle must be non-zero");
  }
  const face = sketch.toFace(oc);
  const o = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
  const d = new oc.gp_Dir_4(axis[0], axis[1], axis[2]);
  const ax = new oc.gp_Ax1_2(o, d);
  const rev = new oc.BRepPrimAPI_MakeRevol_1(face, ax, angle, false);
  const shape = rev.Shape();
  rev.delete();
  ax.delete();
  d.delete();
  o.delete();
  face.delete();
  // Guard the result for parity with loft/sweep/dress-up: should OCCT hand back a
  // null shape for a degenerate-but-nonzero profile (rather than throwing), reject
  // it rather than wrapping an empty Solid and returning it as a success.
  if (shape.IsNull()) throw new Error("revolve: produced an empty shape");
  return new Solid(oc, shape);
}
