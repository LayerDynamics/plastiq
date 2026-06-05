// Body placement (SPEC-5 FR-11): the parametric pose a transform gizmo writes
// back into the feature tree. A placement is a scene-level rigid pose — NOT a
// baked geometry op (that family is the M2.5 "transform" feature driving the
// SPEC-4 kernel translate/rotate/mirror). It is persisted as a `placement`
// feature so it reloads reproducibly and, at M4, composes into each instance's
// COM-frame SimManifest pose.
//
// POSE CONVENTION (export-ready — the kernel/sim exporter must agree):
//   • translation `(tx,ty,tz)` in SI metres, in the world frame;
//   • rotation `(rx,ry,rz)` in radians, intrinsic Euler order **XYZ**, measured
//     about the part's local origin (the world origin for a single part). The
//     gizmo rotates about that origin (acceptable for M1; a centroid pivot is a
//     later refinement).
//
// Pure functions over THREE objects + feature params, so they unit-test in Node.

import * as THREE from "three";
import { PLACEMENT_TYPE, type EditorFeature } from "../store/types.js";

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

/** Apply a placement to an Object3D (e.g. the part group). */
export function applyPlacement(obj: THREE.Object3D, p: Placement): void {
  obj.position.set(p.tx, p.ty, p.tz);
  obj.rotation.set(p.rx, p.ry, p.rz, EULER_ORDER);
}

/** Read an Object3D's current pose back into a placement (XYZ Euler). */
export function readPlacement(obj: THREE.Object3D): Placement {
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, EULER_ORDER);
  return { tx: obj.position.x, ty: obj.position.y, tz: obj.position.z, rx: e.x, ry: e.y, rz: e.z };
}

/** A placement as a flat numeric param record (the feature's `params`). */
export function placementParams(p: Placement): Record<string, number> {
  return { ...p };
}

/** Read a placement from a `placement` feature's params, defaulting to identity. */
export function placementFromFeature(feature: EditorFeature | undefined): Placement {
  const p = feature?.params ?? {};
  return {
    tx: p["tx"] ?? 0,
    ty: p["ty"] ?? 0,
    tz: p["tz"] ?? 0,
    rx: p["rx"] ?? 0,
    ry: p["ry"] ?? 0,
    rz: p["rz"] ?? 0,
  };
}

/** Find the single placement feature in a feature list, if any. */
export function findPlacement(features: readonly EditorFeature[]): EditorFeature | undefined {
  return features.find((f) => f.type === PLACEMENT_TYPE);
}
