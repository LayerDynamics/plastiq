// Catmull-Rom sampling for spline DISPLAY + hit-testing (SPEC-5 FR-16). The
// authoritative curve is the kernel's interpolating B-spline (built at rebuild
// from the same control points); this is a cheap, dependency-free approximation
// for drawing the spline in the 2D overlay and measuring click distance to it.

import type { Px } from "./transform2d.js";

/**
 * Sample a Catmull-Rom spline through `pts` (≥ 2 points), `perSeg` samples per
 * segment, returning the ordered polyline points (including both endpoints).
 */
export function catmullRomPoints(pts: readonly Px[], perSeg = 12): Px[] {
  if (pts.length < 3) return [...pts];
  const clamp = (i: number): Px => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  const out: Px[] = [pts[0]!];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = clamp(i - 1);
    const p1 = clamp(i);
    const p2 = clamp(i + 1);
    const p3 = clamp(i + 2);
    for (let s = 1; s <= perSeg; s++) {
      const t = s / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y });
    }
  }
  return out;
}
