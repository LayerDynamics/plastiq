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
  // Validate the axis BEFORE allocating anything: a zero (or non-finite) axis
  // makes gp_Dir_4 raise an opaque Standard_Failure after `trsf`/`o` exist,
  // which would leak them. Failing here means there is nothing to clean up.
  const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
  if (!Number.isFinite(axisLen) || axisLen === 0) {
    throw new Error("rotate: axis must be a non-zero vector");
  }
  const trash: Array<{ delete(): void }> = [];
  // try/finally so a Standard_Failure from any OCCT constructor still frees the
  // gp_* temporaries made so far.
  try {
    const trsf = new oc.gp_Trsf_1();
    trash.push(trsf);
    const o = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
    trash.push(o);
    const d = new oc.gp_Dir_4(axis[0], axis[1], axis[2]);
    trash.push(d);
    const ax = new oc.gp_Ax1_2(o, d);
    trash.push(ax);
    trsf.SetRotation_1(ax, angle);
    return new Solid(oc, applied(oc, solid.shape, trsf));
  } finally {
    // Reverse order: the axis before the point/direction it was built from.
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/** Mirror a solid across the plane (origin, normal). */
export function mirror(oc: Occt, solid: Solid, origin: Vec3, normal: Vec3): Solid {
  // Validate the normal BEFORE allocating anything — same rationale as rotate.
  const normalLen = Math.hypot(normal[0], normal[1], normal[2]);
  if (!Number.isFinite(normalLen) || normalLen === 0) {
    throw new Error("mirror: plane normal must be a non-zero vector");
  }
  const trash: Array<{ delete(): void }> = [];
  try {
    const trsf = new oc.gp_Trsf_1();
    trash.push(trsf);
    const o = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
    trash.push(o);
    const n = new oc.gp_Dir_4(normal[0], normal[1], normal[2]);
    trash.push(n);
    const ax = new oc.gp_Ax2_3(o, n);
    trash.push(ax);
    trsf.SetMirror_3(ax);
    return new Solid(oc, applied(oc, solid.shape, trsf));
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}
