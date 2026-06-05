// Rigid transforms (BRepBuilderAPI_Transform). Each returns a NEW independent
// solid (Copy = true), so callers can freely delete the input — the rebuild loop
// and pattern fusing rely on this.

import type { TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import type { gp_Trsf } from "opencascade.js";

/** Apply a transform to a shape, returning an independent copy. */
function applied(oc: Occt, shape: TopoDS_Shape, trsf: gp_Trsf): TopoDS_Shape {
  const t = new oc.BRepBuilderAPI_Transform_2(shape, trsf, true);
  const out = t.Shape();
  t.delete();
  return out;
}

/** Translate a solid by `delta` (SI metres). */
export function translate(oc: Occt, solid: Solid, delta: Vec3): Solid {
  const trsf = new oc.gp_Trsf_1();
  const v = new oc.gp_Vec_4(delta[0], delta[1], delta[2]);
  trsf.SetTranslation_1(v);
  const shape = applied(oc, solid.shape, trsf);
  v.delete();
  trsf.delete();
  return new Solid(oc, shape);
}

/** Rotate a solid by `angle` radians about the axis (origin, direction). */
export function rotate(oc: Occt, solid: Solid, origin: Vec3, axis: Vec3, angle: number): Solid {
  const trsf = new oc.gp_Trsf_1();
  const o = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
  const d = new oc.gp_Dir_4(axis[0], axis[1], axis[2]);
  const ax = new oc.gp_Ax1_2(o, d);
  trsf.SetRotation_1(ax, angle);
  const shape = applied(oc, solid.shape, trsf);
  ax.delete();
  d.delete();
  o.delete();
  trsf.delete();
  return new Solid(oc, shape);
}

/** Mirror a solid across the plane (origin, normal). */
export function mirror(oc: Occt, solid: Solid, origin: Vec3, normal: Vec3): Solid {
  const trsf = new oc.gp_Trsf_1();
  const o = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
  const n = new oc.gp_Dir_4(normal[0], normal[1], normal[2]);
  const ax = new oc.gp_Ax2_3(o, n);
  trsf.SetMirror_3(ax);
  const shape = applied(oc, solid.shape, trsf);
  ax.delete();
  n.delete();
  o.delete();
  trsf.delete();
  return new Solid(oc, shape);
}
