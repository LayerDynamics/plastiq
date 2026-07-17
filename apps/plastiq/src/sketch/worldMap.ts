// UV ↔ world mapping for the in-place sketch (ADR-0014). Pure; no React/three.
// Uses only public @plastiq/cad plane APIs (math helpers are package-internal).

import {
  planePointToWorld,
  planeYAxis,
  type DatumPlane,
} from "@plastiq/cad";

export type UV = readonly [number, number];
export type Vec3 = readonly [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Map sketch-plane (u,v) metres to world metres. */
export function uvToWorld(plane: DatumPlane, u: number, v: number): Vec3 {
  return planePointToWorld(plane, u, v);
}

/** Project a world point onto the plane frame as (u,v). Assumes the point is on
 * (or very near) the plane; off-plane points yield the planar components only. */
export function worldToUv(plane: DatumPlane, p: Vec3): UV {
  const d = sub(p, plane.origin);
  const y = planeYAxis(plane);
  return [dot(d, plane.xAxis), dot(d, y)];
}

/** In-plane Y axis (normal × xAxis). */
export function planeVAxis(plane: DatumPlane): Vec3 {
  return planeYAxis(plane);
}

/** Build a world-space point list for a polyline of UV vertices. */
export function uvPolyWorld(plane: DatumPlane, pts: readonly UV[]): Vec3[] {
  return pts.map(([u, v]) => uvToWorld(plane, u, v));
}

/** Sample a circle in UV to world polylines (closed). */
export function circleWorld(
  plane: DatumPlane,
  center: UV,
  radius: number,
  segments = 48,
): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    out.push(uvToWorld(plane, center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)));
  }
  return out;
}

/** Sample a 3-point arc (a → through → b) in UV to world. */
export function arcWorld(
  plane: DatumPlane,
  a: UV,
  through: UV,
  b: UV,
  segments = 24,
): Vec3[] {
  const [x1, y1] = a;
  const [x2, y2] = through;
  const [x3, y3] = b;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-12) {
    return [uvToWorld(plane, a[0], a[1]), uvToWorld(plane, b[0], b[1])];
  }
  const ux =
    ((x1 * x1 + y1 * y1) * (y2 - y3) +
      (x2 * x2 + y2 * y2) * (y3 - y1) +
      (x3 * x3 + y3 * y3) * (y1 - y2)) /
    d;
  const uy =
    ((x1 * x1 + y1 * y1) * (x3 - x2) +
      (x2 * x2 + y2 * y2) * (x1 - x3) +
      (x3 * x3 + y3 * y3) * (x2 - x1)) /
    d;
  const r = Math.hypot(x1 - ux, y1 - uy);
  const a0 = Math.atan2(y1 - uy, x1 - ux);
  const a1 = Math.atan2(y2 - uy, x2 - ux);
  const a2 = Math.atan2(y3 - uy, x3 - ux);
  const norm = (t: number): number => {
    let x = t;
    while (x <= -Math.PI) x += 2 * Math.PI;
    while (x > Math.PI) x -= 2 * Math.PI;
    return x;
  };
  const mid = norm(a1 - a0);
  let end = norm(a2 - a0);
  if (mid * end < 0 || Math.abs(mid) > Math.abs(end)) {
    if (end > 0) end -= 2 * Math.PI;
    else end += 2 * Math.PI;
  }
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = a0 + (end * i) / segments;
    out.push(uvToWorld(plane, ux + r * Math.cos(t), uy + r * Math.sin(t)));
  }
  return out;
}

export type { DatumPlane };
