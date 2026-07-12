// Camera ray ∩ sketch plane → UV (ADR-0014). Pure geometry; no three.js.

import type { DatumPlane } from "@plastiq/cad";
import { worldToUv, type UV, type Vec3 } from "./worldMap.js";

export interface Ray3 {
  /** Ray origin (world metres). */
  readonly origin: Vec3;
  /** Ray direction (need not be unit). */
  readonly direction: Vec3;
}

export type RayPlaneHit =
  | { ok: true; world: Vec3; uv: UV; t: number }
  | { ok: false; reason: "parallel" | "behind" };

const PARALLEL_EPS = 1e-9;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Intersect an infinite ray with the sketch plane. Returns the hit in world and
 * plane UV, or a structured miss (parallel / behind the ray origin).
 */
export function rayIntersectPlane(ray: Ray3, plane: DatumPlane): RayPlaneHit {
  const denom = dot(ray.direction, plane.normal);
  if (Math.abs(denom) < PARALLEL_EPS) return { ok: false, reason: "parallel" };
  const t = dot(sub(plane.origin, ray.origin), plane.normal) / denom;
  if (t < 0) return { ok: false, reason: "behind" };
  const world: Vec3 = [
    ray.origin[0] + ray.direction[0] * t,
    ray.origin[1] + ray.direction[1] * t,
    ray.origin[2] + ray.direction[2] * t,
  ];
  return { ok: true, world, uv: worldToUv(plane, world), t };
}

/** Build a world-space ray from camera origin through a far-plane point. */
export function rayFromCameraThrough(camera: Vec3, through: Vec3): Ray3 {
  return {
    origin: camera,
    direction: [through[0] - camera[0], through[1] - camera[1], through[2] - camera[2]],
  };
}
