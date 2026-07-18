// Body placement (SPEC-5 FR-11): the parametric pose a transform gizmo writes
// back into the feature tree. A placement is a scene-level rigid pose — NOT a
// baked geometry op (that family is the M2.5 "transform" feature driving the
// SPEC-4 kernel translate/rotate/mirror). It is persisted as a `placement`
// feature so it reloads reproducibly, composes into the synthesized body0's
// COM-frame SimManifest pose at lowering, and is baked into the solid at file
// export (§2.11.1) — Simulate and STEP/IGES/glTF see the part exactly where
// the viewport shows it.
//
// POSE CONVENTION (the kernel/sim exporter agrees with this):
//   • translation `(tx,ty,tz)` in SI metres, in the world frame;
//   • rotation `(rx,ry,rz)` in radians, intrinsic Euler order **XYZ**, measured
//     about the part's local origin (the world origin for a single part). The
//     gizmo rotates about that origin (acceptable for M1; a centroid pivot is a
//     later refinement).
//
// THREE is a TYPE-ONLY import here: the Euler↔quaternion conversions are pure
// math pinned to THREE's "XYZ" convention (placement.test.ts proves the match
// against THREE ground truth), so the geometry worker can share this module
// without pulling a scene-graph library into its bundle.

import type * as THREE from "three";
import { PLACEMENT_TYPE, type EditorFeature } from "../store/types.js";
import type { InstancePose, Quat } from "../assembly/model.js";

export { PLACEMENT_TYPE };

/** The Euler convention pinned above; used everywhere a pose is read/written. */
export const EULER_ORDER = "XYZ";

export interface Placement {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}

export const IDENTITY_PLACEMENT: Placement = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

/** True when a placement is exactly the identity pose (nothing to compose). */
export function isIdentityPlacement(p: Placement): boolean {
  return p.tx === 0 && p.ty === 0 && p.tz === 0 && p.rx === 0 && p.ry === 0 && p.rz === 0;
}

/**
 * Intrinsic-XYZ Euler angles → quaternion [x,y,z,w], exactly THREE's
 * `Quaternion.setFromEuler(new Euler(rx, ry, rz, "XYZ"))` (the closed form of
 * qx ∘ qy ∘ qz). This is THE bridge from the M1.3 Euler placement to the
 * quaternion poses the solver/manifest/three.js use end-to-end.
 */
export function eulerXYZQuat(rx: number, ry: number, rz: number): Quat {
  const c1 = Math.cos(rx / 2);
  const s1 = Math.sin(rx / 2);
  const c2 = Math.cos(ry / 2);
  const s2 = Math.sin(ry / 2);
  const c3 = Math.cos(rz / 2);
  const s3 = Math.sin(rz / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/**
 * Quaternion [x,y,z,w] → intrinsic-XYZ Euler angles, exactly THREE's
 * `Euler.setFromQuaternion(q, "XYZ")` (rotation-matrix extraction, including
 * the ry = ±π/2 gimbal branch where rz is pinned to 0).
 */
export function quatToEulerXYZ(q: Quat): [number, number, number] {
  const [x, y, z, w] = q;
  const m13 = 2 * (x * z + w * y);
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    const m23 = 2 * (y * z - w * x);
    const m33 = 1 - 2 * (x * x + y * y);
    const m12 = 2 * (x * y - w * z);
    const m11 = 1 - 2 * (y * y + z * z);
    return [Math.atan2(-m23, m33), ry, Math.atan2(-m12, m11)];
  }
  const m32 = 2 * (y * z + w * x);
  const m22 = 1 - 2 * (x * x + z * z);
  return [Math.atan2(m32, m22), ry, 0];
}

/** Apply a placement to an Object3D (e.g. the part group). */
export function applyPlacement(obj: THREE.Object3D, p: Placement): void {
  obj.position.set(p.tx, p.ty, p.tz);
  obj.rotation.set(p.rx, p.ry, p.rz, EULER_ORDER);
}

/** Read an Object3D's current pose back into a placement (XYZ Euler). */
export function readPlacement(obj: THREE.Object3D): Placement {
  const q = obj.quaternion;
  const [rx, ry, rz] = quatToEulerXYZ([q.x, q.y, q.z, q.w]);
  return { tx: obj.position.x, ty: obj.position.y, tz: obj.position.z, rx, ry, rz };
}

/** A placement as a flat numeric param record (the feature's `params`). */
export function placementParams(p: Placement): Record<string, number> {
  return { ...p };
}

/** Read a placement out of a flat param record — the inverse of {@link placementParams},
 * defaulting every missing component to identity. */
export function placementFromParams(params: Record<string, number> | undefined): Placement {
  const p = params ?? {};
  return {
    tx: p["tx"] ?? 0,
    ty: p["ty"] ?? 0,
    tz: p["tz"] ?? 0,
    rx: p["rx"] ?? 0,
    ry: p["ry"] ?? 0,
    rz: p["rz"] ?? 0,
  };
}

/** Read a placement from a `placement` feature's params, defaulting to identity. */
export function placementFromFeature(feature: EditorFeature | undefined): Placement {
  return placementFromParams(feature?.params);
}

/** Find the single placement feature in a feature list, if any. */
export function findPlacement(features: readonly EditorFeature[]): EditorFeature | undefined {
  return features.find((f) => f.type === PLACEMENT_TYPE);
}

/**
 * The document's placement as a quaternion world pose — identity when there is
 * no placement feature. The ONE conversion both sides of the sim seam share:
 * the worker poses its synthesized body0 with it and the viewport seeds the
 * sim render bodies with it, so they cannot disagree (§2.11.1).
 */
export function placementPoseOf(features: readonly EditorFeature[]): InstancePose {
  const p = placementFromFeature(findPlacement(features));
  return { position: [p.tx, p.ty, p.tz], orientation: eulerXYZQuat(p.rx, p.ry, p.rz) };
}
