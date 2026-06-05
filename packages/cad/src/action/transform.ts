// Transform feature (SPEC-4 FR-14): rigid placement (translate/rotate) and
// mirror of a solid, via gp_Trsf + BRepBuilderAPI_Transform.

import type { gp_Trsf } from "opencascade.js";
import { normalize, type Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";

function applyTrsf(oc: Occt, solid: Solid, trsf: gp_Trsf): Solid {
  const mk = new oc.BRepBuilderAPI_Transform_2(solid.shape, trsf, true);
  try {
    return new Solid(oc, mk.Shape());
  } finally {
    mk.delete();
  }
}

/** Translate `solid` by `v` (SI). */
export function translate(oc: Occt, solid: Solid, v: Vec3): Solid {
  const trsf = new oc.gp_Trsf_1();
  const vec = new oc.gp_Vec_4(v[0], v[1], v[2]);
  try {
    trsf.SetTranslation_1(vec);
    return applyTrsf(oc, solid, trsf);
  } finally {
    vec.delete();
    trsf.delete();
  }
}

/** Rotate `solid` by `angle` (rad) about the axis (`origin`, `dir`). */
export function rotate(oc: Occt, solid: Solid, origin: Vec3, dir: Vec3, angle: number): Solid {
  const n = normalize(dir);
  const trsf = new oc.gp_Trsf_1();
  const p = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
  const d = new oc.gp_Dir_4(n[0], n[1], n[2]);
  const axis = new oc.gp_Ax1_2(p, d);
  try {
    trsf.SetRotation_1(axis, angle);
    return applyTrsf(oc, solid, trsf);
  } finally {
    axis.delete();
    d.delete();
    p.delete();
    trsf.delete();
  }
}

/** Mirror `solid` across the plane (`origin`, `normal`). */
export function mirror(oc: Occt, solid: Solid, origin: Vec3, normal: Vec3): Solid {
  const n = normalize(normal);
  const trsf = new oc.gp_Trsf_1();
  const p = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
  const d = new oc.gp_Dir_4(n[0], n[1], n[2]);
  const plane = new oc.gp_Ax2_3(p, d);
  try {
    trsf.SetMirror_3(plane);
    return applyTrsf(oc, solid, trsf);
  } finally {
    plane.delete();
    d.delete();
    p.delete();
    trsf.delete();
  }
}
