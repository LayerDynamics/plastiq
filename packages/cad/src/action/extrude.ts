// Extrude (linear prism) of a sketch profile.

import type { TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { normalize, scale } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";

export interface ExtrudeOptions {
  /** Extrude this far in the OPPOSITE direction too (two-sided pad). */
  readonly back?: number;
  /** Override the extrude direction (default: the sketch plane normal). */
  readonly direction?: Vec3;
}

/** Shift a shape by `delta`, returning an independent copy. */
function shifted(oc: Occt, shape: TopoDS_Shape, delta: Vec3): TopoDS_Shape {
  const trsf = new oc.gp_Trsf_1();
  const v = new oc.gp_Vec_4(delta[0], delta[1], delta[2]);
  trsf.SetTranslation_1(v);
  const t = new oc.BRepBuilderAPI_Transform_2(shape, trsf, true);
  const out = t.Shape();
  t.delete();
  v.delete();
  trsf.delete();
  return out;
}

/**
 * Extrude a sketch profile by `height` (SI metres) along the plane normal (or
 * `opts.direction`). With `opts.back`, also extrude that far the other way for a
 * symmetric two-sided pad.
 */
export function extrude(
  oc: Occt,
  sketch: Sketch,
  height: number,
  opts?: ExtrudeOptions,
): Solid {
  const dir = normalize(opts?.direction ?? sketch.plane.normal);
  const back = opts?.back ?? 0;
  const face = sketch.toFace(oc);

  let baseFace = face;
  if (back !== 0) {
    baseFace = shifted(oc, face, scale(dir, -back));
    face.delete();
  }

  const total = height + back;
  const ext = scale(dir, total);
  const v = new oc.gp_Vec_4(ext[0], ext[1], ext[2]);
  const prism = new oc.BRepPrimAPI_MakePrism_1(baseFace, v, false, true);
  const shape = prism.Shape();
  prism.delete();
  v.delete();
  baseFace.delete();
  return new Solid(oc, shape);
}
