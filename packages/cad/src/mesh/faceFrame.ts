// Derive a sketch datum frame from a model face, so a sketch can be drawn directly
// on a picked face (and offset off it). The frame is the face's area centroid
// (origin), its outward normal, and a stable in-plane X axis. Exact for planar
// faces; a curved face yields an approximate frame through the centroid with the
// average normal (sketching on curved faces isn't a supported workflow).

import type { TopoDS_Face } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { DatumPlane } from "../env/plane.js";
import { dot, normalize, scale, sub, type Vec3 } from "../math/index.js";
import { faceNormal } from "./normals.js";

export function faceDatumPlane(oc: Occt, face: TopoDS_Face): DatumPlane {
  const normal = faceNormal(oc, face);
  // Area centroid — a point on the face, centred (the same call extrude-to-face
  // uses). GProp surface properties → centre of mass.
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const c = props.CentreOfMass();
  const origin: Vec3 = [c.X(), c.Y(), c.Z()];
  c.delete();
  props.delete();
  // A stable in-plane X axis: take the world axis least parallel to the normal and
  // project the normal component out, then normalise. (Avoids a degenerate axis
  // when the normal is itself ±X.)
  const ref: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const xAxis = normalize(sub(ref, scale(normal, dot(ref, normal))));
  return { origin, normal, xAxis };
}
