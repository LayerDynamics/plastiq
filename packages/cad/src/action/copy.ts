// Copy / pattern feature (SPEC-4 FR-15): instanced copies — linear pattern,
// circular pattern, and mirror — built on the rigid transforms (transform.ts).
// Returns the instances; the caller may union them into one body if desired.

import { scale, type Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import { rotate, translate } from "./transform.js";

/** `count` copies of `solid` spaced by `spacing` along `dir` (instance 0 = original placement). */
export function linearPattern(
  oc: Occt,
  solid: Solid,
  dir: Vec3,
  spacing: number,
  count: number,
): Solid[] {
  if (count < 1) throw new Error("linearPattern needs count ≥ 1");
  const out: Solid[] = [];
  for (let i = 0; i < count; i++) {
    out.push(translate(oc, solid, scale(dir, spacing * i)));
  }
  return out;
}

/** `count` copies of `solid` evenly rotated about the axis (`origin`, `axisDir`) over `totalAngle` (default 2π). */
export function circularPattern(
  oc: Occt,
  solid: Solid,
  origin: Vec3,
  axisDir: Vec3,
  count: number,
  totalAngle: number = 2 * Math.PI,
): Solid[] {
  if (count < 1) throw new Error("circularPattern needs count ≥ 1");
  // A full revolution wraps, so the per-step angle divides by count; a partial
  // sweep divides by (count − 1) so endpoints land on the sweep bounds.
  const full = Math.abs(totalAngle - 2 * Math.PI) < 1e-12;
  const step = full ? totalAngle / count : totalAngle / Math.max(count - 1, 1);
  const out: Solid[] = [];
  for (let i = 0; i < count; i++) {
    out.push(rotate(oc, solid, origin, axisDir, step * i));
  }
  return out;
}
