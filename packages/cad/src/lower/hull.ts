// 3D convex hull (SPEC-4 FR-26 lowering support). An incremental hull over a
// point cloud (a solid's tessellation), producing hull vertices + outward-wound
// triangle faces — the exact form `mechx_sim::collision::Shape::ConvexHull`
// consumes (geo-bindgen derives per-face normals and mass properties from them).
//
// Pure f64 math, deterministic (no Math.random / Set iteration order in the
// geometry path — NFR-2): points are processed in input order and faces orient
// against a fixed interior reference point.

import { cross, dot, sub, type Vec3 } from "../math/index.js";

export interface Hull {
  readonly vertices: Vec3[];
  readonly faces: [number, number, number][];
}

interface Face {
  a: number;
  b: number;
  c: number;
  normal: Vec3; // outward unit-ish normal (not normalized; sign is what matters)
}

/** Squared distance between two points. */
function dist2(p: Vec3, q: Vec3): number {
  const dx = p[0] - q[0];
  const dy = p[1] - q[1];
  const dz = p[2] - q[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Deduplicate points within `tol` (grid-quantized), preserving first-seen order. */
function dedupe(points: readonly Vec3[], tol: number): Vec3[] {
  const seen = new Map<string, number>();
  const out: Vec3[] = [];
  const inv = 1 / tol;
  for (const p of points) {
    const key = `${Math.round(p[0] * inv)},${Math.round(p[1] * inv)},${Math.round(p[2] * inv)}`;
    if (!seen.has(key)) {
      seen.set(key, out.length);
      out.push(p);
    }
  }
  return out;
}

/** Outward normal of triangle (a,b,c), flipped so it points away from `interior`. */
function faceNormal(pts: readonly Vec3[], a: number, b: number, c: number, interior: Vec3): Vec3 {
  const n = cross(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!));
  // Point away from the interior reference: n·(a − interior) must be ≥ 0.
  return dot(n, sub(pts[a]!, interior)) < 0 ? [-n[0], -n[1], -n[2]] : n;
}

function makeFace(pts: readonly Vec3[], a: number, b: number, c: number, interior: Vec3): Face {
  const normal = faceNormal(pts, a, b, c, interior);
  // Re-derive the winding so (a,b,c) matches the chosen outward normal: if the
  // raw winding disagrees, swap b/c so consumers reading the index triple get
  // the same outward orientation as `normal`.
  const raw = cross(sub(pts[b]!, pts[a]!), sub(pts[c]!, pts[a]!));
  if (dot(raw, normal) < 0) return { a, b: c, c: b, normal };
  return { a, b, c, normal };
}

/**
 * The convex hull of `points`. Throws if the points are degenerate (fewer than
 * 4 unique, or all coplanar/collinear — no positive volume).
 */
export function convexHull(points: readonly Vec3[]): Hull {
  // Relative tolerance scaled to the cloud's extent.
  let scale = 0;
  for (const p of points) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps = 1e-9 * (scale || 1);
  const pts = dedupe(points, Math.max(eps, 1e-12));
  if (pts.length < 4) {
    throw new Error(`convex hull needs ≥ 4 unique points, got ${pts.length}`);
  }

  // --- initial tetrahedron: 4 affinely independent points ---------------------
  // i0: extreme in x.
  let i0 = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]![0] < pts[i0]![0]) i0 = i;
  // i1: farthest from i0.
  let i1 = -1;
  let best = eps * eps;
  for (let i = 0; i < pts.length; i++) {
    const d = dist2(pts[i]!, pts[i0]!);
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  if (i1 < 0) throw new Error("degenerate point cloud (all coincident)");
  // i2: farthest from the line i0–i1.
  const e01 = sub(pts[i1]!, pts[i0]!);
  let i2 = -1;
  best = eps * eps;
  for (let i = 0; i < pts.length; i++) {
    const c = cross(e01, sub(pts[i]!, pts[i0]!));
    const d = dot(c, c) / (dot(e01, e01) || 1);
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  if (i2 < 0) throw new Error("degenerate point cloud (collinear)");
  // i3: farthest from the plane i0–i1–i2.
  const planeN = cross(e01, sub(pts[i2]!, pts[i0]!));
  let i3 = -1;
  best = eps;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(dot(planeN, sub(pts[i]!, pts[i0]!)));
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i3 < 0) throw new Error("degenerate point cloud (coplanar — no volume)");

  // Fixed interior reference: the tetra centroid stays strictly inside the
  // growing hull, so every face can be oriented outward against it.
  const interior: Vec3 = [
    (pts[i0]![0] + pts[i1]![0] + pts[i2]![0] + pts[i3]![0]) / 4,
    (pts[i0]![1] + pts[i1]![1] + pts[i2]![1] + pts[i3]![1]) / 4,
    (pts[i0]![2] + pts[i1]![2] + pts[i2]![2] + pts[i3]![2]) / 4,
  ];

  let faces: Face[] = [
    makeFace(pts, i0, i1, i2, interior),
    makeFace(pts, i0, i1, i3, interior),
    makeFace(pts, i0, i2, i3, interior),
    makeFace(pts, i1, i2, i3, interior),
  ];

  const inTetra = new Set([i0, i1, i2, i3]);
  // Visibility tolerance scaled to the model.
  const visEps = eps * (scale || 1) + 1e-15;

  for (let p = 0; p < pts.length; p++) {
    if (inTetra.has(p)) continue;
    const point = pts[p]!;
    const visible: Face[] = [];
    const hidden: Face[] = [];
    for (const f of faces) {
      if (dot(f.normal, sub(point, pts[f.a]!)) > visEps) visible.push(f);
      else hidden.push(f);
    }
    if (visible.length === 0) continue; // inside the current hull

    // Horizon = directed edges of visible faces whose twin is not on a visible
    // face (i.e. they border the hidden region).
    const visibleEdges = new Set<string>();
    for (const f of visible) {
      visibleEdges.add(`${f.a},${f.b}`);
      visibleEdges.add(`${f.b},${f.c}`);
      visibleEdges.add(`${f.c},${f.a}`);
    }
    const horizon: [number, number][] = [];
    for (const f of visible) {
      for (const [u, v] of [
        [f.a, f.b],
        [f.b, f.c],
        [f.c, f.a],
      ] as [number, number][]) {
        if (!visibleEdges.has(`${v},${u}`)) horizon.push([u, v]);
      }
    }

    faces = hidden;
    for (const [u, v] of horizon) {
      faces.push(makeFace(pts, u, v, p, interior));
    }
  }

  // --- collect used vertices, reindex ----------------------------------------
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
  const outFaces: [number, number, number][] = faces.map((f) => [
    remap(f.a),
    remap(f.b),
    remap(f.c),
  ]);
  return { vertices, faces: outFaces };
}
