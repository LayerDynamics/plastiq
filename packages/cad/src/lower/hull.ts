// 3D convex hull (incremental algorithm) — turns a part's tessellated vertices
// into the exact convex collision shape used by the physics layer, instead of a
// generic bounding box. Output is a deduped vertex list + triangular faces
// (indices into those vertices), which every backend's convex-hull collider
// accepts (Rapier convexHull, ammo btConvexHullShape, cannon ConvexPolyhedron,
// MuJoCo mesh asset).

import type { Vec3 } from "../math/index.js";
import { cross, dot, sub } from "../math/index.js";

export interface ConvexHull {
  /** Hull vertices (a subset of the input, deduped). */
  vertices: Vec3[];
  /** Outward-facing triangles as index triples into `vertices`. */
  faces: [number, number, number][];
}

interface Face {
  a: number;
  b: number;
  c: number;
  // Outward plane normal + offset (n·x = d) for the supporting plane.
  normal: Vec3;
  d: number;
}

const EPS = 1e-9;

function planeOf(pts: Vec3[], a: number, b: number, c: number, inside: Vec3): Face {
  const n0 = cross(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!));
  let normal = n0;
  let d = dot(normal, pts[a]!);
  // Orient the normal to face away from an interior point.
  if (dot(normal, inside) - d > 0) {
    normal = [-normal[0], -normal[1], -normal[2]];
    d = -d;
  }
  return { a, b, c, normal, d };
}

/** Distance of point p above face f's plane (positive = outside/visible). */
function above(f: Face, p: Vec3): number {
  return dot(f.normal, p) - f.d;
}

/**
 * Compute the convex hull of `input`. Throws if the points are degenerate
 * (fewer than 4, or all coplanar) — a valid 3D solid's tessellation never is.
 */
export function convexHull(input: readonly Vec3[]): ConvexHull {
  // Dedup coincident points (the tessellation duplicates corners per face).
  const pts: Vec3[] = [];
  for (const p of input) {
    if (!pts.some((q) => Math.abs(q[0] - p[0]) < EPS && Math.abs(q[1] - p[1]) < EPS && Math.abs(q[2] - p[2]) < EPS)) {
      pts.push([p[0], p[1], p[2]]);
    }
  }
  if (pts.length < 4) throw new Error("convexHull: need ≥ 4 non-coplanar points");

  // --- Seed tetrahedron: pick 4 affinely-independent points.
  const i0 = 0;
  let i1 = -1;
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(...sub(pts[i]!, pts[i0]!)) > EPS) {
      i1 = i;
      break;
    }
  }
  if (i1 < 0) throw new Error("convexHull: all points coincident");
  let i2 = -1;
  let bestArea = EPS;
  for (let i = 0; i < pts.length; i++) {
    if (i === i0 || i === i1) continue;
    const area = Math.hypot(...cross(sub(pts[i1]!, pts[i0]!), sub(pts[i]!, pts[i0]!)));
    if (area > bestArea) {
      bestArea = area;
      i2 = i;
    }
  }
  if (i2 < 0) throw new Error("convexHull: all points collinear");
  let i3 = -1;
  let bestVol = EPS;
  const baseN = cross(sub(pts[i1]!, pts[i0]!), sub(pts[i2]!, pts[i0]!));
  for (let i = 0; i < pts.length; i++) {
    if (i === i0 || i === i1 || i === i2) continue;
    const vol = Math.abs(dot(baseN, sub(pts[i]!, pts[i0]!)));
    if (vol > bestVol) {
      bestVol = vol;
      i3 = i;
    }
  }
  if (i3 < 0) throw new Error("convexHull: all points coplanar");

  const centroid: Vec3 = [
    (pts[i0]![0] + pts[i1]![0] + pts[i2]![0] + pts[i3]![0]) / 4,
    (pts[i0]![1] + pts[i1]![1] + pts[i2]![1] + pts[i3]![1]) / 4,
    (pts[i0]![2] + pts[i1]![2] + pts[i2]![2] + pts[i3]![2]) / 4,
  ];
  let faces: Face[] = [
    planeOf(pts, i0, i1, i2, centroid),
    planeOf(pts, i0, i1, i3, centroid),
    planeOf(pts, i0, i2, i3, centroid),
    planeOf(pts, i1, i2, i3, centroid),
  ];

  // --- Incremental insertion of the remaining points.
  const seed = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < pts.length; i++) {
    if (seed.has(i)) continue;
    const p = pts[i]!;
    const visible = faces.filter((f) => above(f, p) > EPS);
    if (visible.length === 0) continue; // inside the current hull

    // Horizon = edges bordering exactly one visible face.
    const edgeCount = new Map<string, { u: number; v: number; n: number }>();
    const bump = (u: number, v: number): void => {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const e = edgeCount.get(key);
      if (e) e.n++;
      else edgeCount.set(key, { u, v, n: 1 });
    };
    for (const f of visible) {
      bump(f.a, f.b);
      bump(f.b, f.c);
      bump(f.c, f.a);
    }
    faces = faces.filter((f) => above(f, p) <= EPS);
    for (const e of edgeCount.values()) {
      if (e.n === 1) faces.push(planeOf(pts, e.u, e.v, i, centroid));
    }
  }

  // --- Compact to the used vertices.
  const used = new Map<number, number>();
  const vertices: Vec3[] = [];
  const remap = (idx: number): number => {
    let r = used.get(idx);
    if (r === undefined) {
      r = vertices.length;
      used.set(idx, r);
      vertices.push(pts[idx]!);
    }
    return r;
  };
  const outFaces: [number, number, number][] = faces.map((f) => [remap(f.a), remap(f.b), remap(f.c)]);
  return { vertices, faces: outFaces };
}
