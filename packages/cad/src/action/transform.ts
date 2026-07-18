// Transforms (BRepBuilderAPI_Transform). Each returns a NEW independent solid
// (Copy = true), so callers can freely delete the input — the rebuild loop and
// pattern fusing rely on this.
//
// translate/rotate/mirror are rigid (distance-preserving); `scale` is not, and is
// the one operation here that changes size. It is what the interchange boundary
// uses to convert the kernel's SI metres to a file's declared units (I1).

import type { TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import type { gp_Trsf } from "opencascade.js";

/** Apply a transform to a shape, returning an independent copy.
 * Frees the maker on every exit, including Standard_Failure (T19). */
function applied(oc: Occt, shape: TopoDS_Shape, trsf: gp_Trsf): TopoDS_Shape {
  const t = new oc.BRepBuilderAPI_Transform_2(shape, trsf, true);
  try {
    const out = t.Shape();
    // Real OCCT shapes expose IsNull(); unit-test mocks may not.
    if (typeof (out as { IsNull?: () => boolean }).IsNull === "function" && out.IsNull()) {
      out.delete();
      throw new Error("transform: produced an empty shape");
    }
    return out;
  } finally {
    t.delete();
  }
}

/**
 * Apply a full rigid pose — quaternion rotation about the local origin, then
 * translation — in ONE kernel transform. This is the pose an assembly instance
 * (or a body placement) carries, so posing a local-frame solid into world space
 * is a single call rather than a chain of axis-angle rotations.
 *
 * gp_Trsf's quaternion setters (`SetRotation_2` / `SetTransformation_3`) are
 * unusable here: `gp_Quaternion` binds only as a parameter/return TYPE in the
 * trimmed wasm — there is no constructor to call (pinned by
 * oc/bindings.test.ts). `SetValues` takes the general 3×4 affine instead, so
 * the rotation matrix is built from the quaternion here and handed over whole.
 *
 * The quaternion is normalized first: `SetValues` checks the 3×3 block is
 * orthogonal within tolerance and raises Standard_ConstructionError on drift,
 * and a solver-produced pose can accumulate a little.
 */
export function transformRigid(
  oc: Occt,
  solid: Solid,
  orientation: readonly [number, number, number, number],
  translation: Vec3,
): Solid {
  const n = Math.hypot(orientation[0], orientation[1], orientation[2], orientation[3]);
  if (!Number.isFinite(n) || n === 0) {
    throw new Error("transformRigid: orientation must be a non-zero quaternion");
  }
  const x = orientation[0] / n;
  const y = orientation[1] / n;
  const z = orientation[2] / n;
  const w = orientation[3] / n;
  // Standard quaternion → rotation matrix (column-vector convention, matching
  // the app's quatRotate and three.js).
  const trsf = new oc.gp_Trsf_1();
  try {
    trsf.SetValues(
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z),     2 * (x * z + w * y),     translation[0],
      2 * (x * y + w * z),     1 - 2 * (x * x + z * z), 2 * (y * z - w * x),     translation[1],
      2 * (x * z - w * y),     2 * (y * z + w * x),     1 - 2 * (x * x + y * y), translation[2],
    );
    return new Solid(oc, applied(oc, solid.shape, trsf));
  } finally {
    trsf.delete();
  }
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

/**
 * Uniformly scale a solid by `factor` about `centre` (default the origin).
 *
 * The kernel had NO scale operation (§4.11), which left two holes: a user could
 * not resize a body at all, and the interchange boundary had no way to convert
 * SI metres to a file's declared units (I1) — so STEP shipped a 1000× error.
 *
 * Uniform only, deliberately: gp_Trsf models a similarity transform and a
 * NON-uniform scale is not one. Passing per-axis factors to gp_GTrsf turns
 * circles into ellipses and planes into different planes, so every analytic
 * surface the kernel relies on (§2.1's FaceRef signatures, fillets, offsets)
 * would degrade to a B-spline. A uniform scale maps a cylinder to a cylinder.
 */
export function scale(oc: Occt, solid: Solid, factor: number, centre: Vec3 = [0, 0, 0]): Solid {
  // Validate BEFORE allocating: 0 collapses the solid to a point and a negative
  // factor is a mirror-plus-scale that silently inverts orientation — both
  // produce a "valid" shape OCCT will not complain about.
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`scale: factor must be a finite number > 0 (got ${factor})`);
  }
  const trsf = new oc.gp_Trsf_1();
  const p = new oc.gp_Pnt_3(centre[0], centre[1], centre[2]);
  try {
    trsf.SetScale(p, factor);
    return new Solid(oc, applied(oc, solid.shape, trsf));
  } finally {
    p.delete();
    trsf.delete();
  }
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
