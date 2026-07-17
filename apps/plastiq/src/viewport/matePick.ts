// Mate authoring input (M4.2): turn a pointer hit on an assembly INSTANCE into
// the mate pick the store records.
//
// Kept pure (no r3f/React) so it unit-tests in Node — the same idiom as pick.ts
// and viewport/dressup.ts. That matters here specifically: the mate SOLVER was
// always real and wired, but nothing in the app ever called `addMatePick`, so
// "Add mate → Picking 0/2" could never advance and every mate menu item was
// permanently disabled. The one e2e that covered mates drove the store seam
// directly, so it passed while the feature was unreachable — a pure resolver is
// what lets the missing step be tested rather than bypassed.

import type * as THREE from "three";
import { faceIdOfMesh } from "./pick.js";

/** An instance face the user picked, in the shape `CadStore.addMatePick` takes. */
export interface MatePickHit {
  instanceId: string;
  faceId: number;
  worldPoint: [number, number, number];
}

/** A pointer hit on an instance, in the shape r3f's ThreeEvent exposes. */
export interface InstancePointerHit {
  instanceId: string;
  /** Mouse button (0 = left). Right/middle must not author a mate. */
  button: number;
  /** Index of the raycast triangle; null/undefined when the hit carries no face
   * (r3f's ThreeEvent types it `number | null | undefined`). */
  faceIndex: number | null | undefined;
  /** The picked mesh (carries the faceIds + render groups). */
  object: THREE.Mesh;
  /** World-space hit point. */
  point: { x: number; y: number; z: number };
}

/**
 * Resolve an instance pointer hit into a mate pick, or null when the hit is not
 * one (wrong button, no triangle, or a triangle outside every face group).
 *
 * The instance's group is built from the same tagged mesh as the base part, so
 * the triangle → render-group → faceId mapping is identical and the resulting
 * `faceId` indexes the SAME `selectionRefs.faces` table `addMatePick` reads.
 */
export function resolveMatePick(hit: InstancePointerHit): MatePickHit | null {
  if (hit.button !== 0) return null; // left-click only; right-click opens the menu
  if (hit.faceIndex == null) return null;
  const faceId = faceIdOfMesh(hit.object, hit.faceIndex);
  if (faceId == null) return null;
  return {
    instanceId: hit.instanceId,
    faceId,
    worldPoint: [hit.point.x, hit.point.y, hit.point.z],
  };
}
