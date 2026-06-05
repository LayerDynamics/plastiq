// Extrude feature (SPEC-4 FR-4 / SPEC-5 FR-29): a solid by linear extrusion of a
// sketch profile, via OCCT BRepPrimAPI_MakePrism. Extrudes along the sketch-plane
// normal by default, or along a supplied direction (e.g. a picked edge), and can
// be two-sided (also extrude `back` in the opposite direction).

import type { TopoDS_Shape } from "opencascade.js";
import { dot, normalize, scale, sub, type Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import type { Sketch } from "../sketch/sketch.js";
import { Solid } from "../solid/solid.js";
import { resolveFaceCenter, type FaceRef } from "./selection.js";

export interface ExtrudeOptions {
  /** Extrude direction (default: the sketch-plane normal). Normalised internally. */
  direction?: Vec3;
  /** Also extrude this far in the opposite direction (two-sided). Default 0. */
  back?: number;
}

/**
 * Extrude `sketch` by `distance` (SI metres). With `back > 0` the profile is also
 * extruded `back` the other way (a two-sided pad spanning `distance + back`).
 */
export function extrude(
  oc: Occt,
  sketch: Sketch,
  distance: number,
  opts: ExtrudeOptions = {},
): Solid {
  const dir = normalize(opts.direction ?? sketch.plane.normal);
  const back = opts.back ?? 0;
  const face = sketch.toFace(oc);
  // For a two-sided pad, shift the base face `back` along −dir, then extrude the
  // full span (back + distance) along +dir.
  let base: TopoDS_Shape = face;
  let xf: { Shape(): TopoDS_Shape; delete(): void } | null = null;
  let shiftVec: { delete(): void } | null = null;
  let shiftTrsf: { delete(): void } | null = null;
  if (back !== 0) {
    const [sx, sy, sz] = scale(dir, -back);
    const v = new oc.gp_Vec_4(sx, sy, sz);
    const t = new oc.gp_Trsf_1();
    t.SetTranslation_1(v);
    const transform = new oc.BRepBuilderAPI_Transform_2(face, t, true);
    base = transform.Shape();
    xf = transform;
    shiftVec = v;
    shiftTrsf = t;
  }
  const [vx, vy, vz]: Vec3 = scale(dir, distance + back);
  const vec = new oc.gp_Vec_4(vx, vy, vz);
  const prism = new oc.BRepPrimAPI_MakePrism_1(base, vec, false, true);
  try {
    return new Solid(oc, prism.Shape());
  } finally {
    prism.delete();
    vec.delete();
    xf?.delete();
    shiftTrsf?.delete();
    shiftVec?.delete();
    face.delete();
  }
}

/**
 * Extrude `sketch` up to the plane of a picked face on `solid` (FR-29). The
 * distance is the signed projection (along `direction`, default plane normal)
 * from the sketch origin to the target face's centroid. Throws if the face can't
 * be resolved against the current build (FR-16/R2).
 */
export function extrudeToFace(
  oc: Occt,
  sketch: Sketch,
  solid: Solid,
  ref: FaceRef,
  opts: { direction?: Vec3 } = {},
): Solid {
  const dir = normalize(opts.direction ?? sketch.plane.normal);
  const center = resolveFaceCenter(oc, solid, ref);
  if (!center) throw new Error("extrude-to-face: target face could not be resolved");
  const distance = dot(sub(center, sketch.plane.origin), dir);
  return extrude(oc, sketch, distance, { direction: dir });
}
