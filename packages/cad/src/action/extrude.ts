// Extrude (linear prism) of a sketch profile.

import type { TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { dot, normalize, scale, sub } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";
import { resolveFaceRef } from "../mesh/resolve.js";
import type { FaceRef } from "../mesh/tagged.js";

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

export interface ExtrudeToFaceOptions {
  /** Override the extrude direction (default: the sketch plane normal). */
  readonly direction?: Vec3;
}

/**
 * Extrude a sketch profile from its plane up to the picked face of `base`. The
 * pad height is the distance from the sketch plane to the target face's centroid
 * projected onto the extrude direction. Returns the PAD; the caller fuses it.
 */
export function extrudeToFace(
  oc: Occt,
  sketch: Sketch,
  base: Solid,
  toFace: FaceRef,
  opts?: ExtrudeToFaceOptions,
): Solid {
  const dir = normalize(opts?.direction ?? sketch.plane.normal);
  const face = resolveFaceRef(oc, base, toFace);
  if (!face) throw new Error("extrudeToFace: the target face did not resolve on the body");

  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const com = props.CentreOfMass();
  const centroid: Vec3 = [com.X(), com.Y(), com.Z()];
  com.delete();
  props.delete();
  face.delete();

  const signed = dot(sub(centroid, sketch.plane.origin), dir);
  if (Math.abs(signed) < 1e-9) {
    throw new Error("extrudeToFace: the target face lies on the sketch plane");
  }
  return extrude(oc, sketch, Math.abs(signed), {
    direction: signed >= 0 ? dir : scale(dir, -1),
  });
}
