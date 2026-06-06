// SimManifest — the physics-ready description produced by @plastiq/cad's
// exportForSim and consumed here. Structurally identical to the kernel's type
// (kept in sync deliberately; the two packages stay decoupled — no import).
// Each body is a compound of one or more convex-hull colliders (one for a convex
// part; several for a concave part decomposed into convex pieces).

/** A convex-hull collider in the body's local frame (centred at the COM). */
export interface HullCollider {
  /** Flat hull vertices `[x0,y0,z0, …]` (COM-relative). */
  points: number[];
  /** Triangular faces as index triples into `points`/3. */
  faces: number[][];
}

export interface ManifestBody {
  id: string;
  mass: number;
  com: [number, number, number];
  orientation: [number, number, number, number];
  /** One or more convex-hull pieces (a compound collider). Always non-empty. */
  colliders: HullCollider[];
  fixed?: boolean;
}

export interface ManifestConstraint {
  kind: "hinge" | "fixed";
  bodyA: string;
  bodyB: string;
  origin: [number, number, number];
  axis: [number, number, number];
}

export interface SimManifest {
  version: 1;
  source: string;
  gravity: [number, number, number];
  bodies: ManifestBody[];
  constraints: ManifestConstraint[];
}

/**
 * Volume of a CONVEX hull collider. Sums the unsigned tetrahedra from the hull
 * centroid to each face — winding-independent, so it is correct even when the
 * hull's triangles aren't consistently wound (the kernel's convexHull orients
 * face normals but not vertex order). Valid for convex shapes: the centroid is
 * interior and its fan tetrahedra tile the hull exactly. Used to mass-weight the
 * pieces of a compound collider so they share one density and the body's total
 * mass is exact.
 *
 * NOTE: `@plastiq/cad`'s `meshVolume` (in lower/decompose.ts) is the deliberate
 * mirror of this — `@plastiq/sim` stays standalone (it never imports the kernel;
 * the manifest types are hand-mirrored for the same reason), so the algorithm is
 * duplicated rather than shared. Keep the two in lock-step if either changes.
 */
export function hullVolume(hull: HullCollider): number {
  const p = hull.points;
  const n = p.length / 3;
  if (n < 4) return 0;
  let gx = 0,
    gy = 0,
    gz = 0;
  for (let i = 0; i < n; i++) {
    gx += p[3 * i]!;
    gy += p[3 * i + 1]!;
    gz += p[3 * i + 2]!;
  }
  gx /= n;
  gy /= n;
  gz /= n;
  let v = 0;
  for (const f of hull.faces) {
    const i = f[0]! * 3;
    const j = f[1]! * 3;
    const k = f[2]! * 3;
    const ax = p[i]! - gx,
      ay = p[i + 1]! - gy,
      az = p[i + 2]! - gz;
    const bx = p[j]! - gx,
      by = p[j + 1]! - gy,
      bz = p[j + 2]! - gz;
    const cx = p[k]! - gx,
      cy = p[k + 1]! - gy,
      cz = p[k + 2]! - gz;
    // |a · (b × c)|
    v += Math.abs(ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx));
  }
  return v / 6;
}

/** Parse + validate a manifest JSON string. */
const isVec = (x: unknown, n: number): boolean =>
  Array.isArray(x) && x.length === n && x.every((v) => typeof v === "number" && Number.isFinite(v));

export function parseManifest(json: string): SimManifest {
  const m = JSON.parse(json) as SimManifest;
  if (m.version !== 1) throw new Error(`unsupported SimManifest version ${m.version}`);
  if (!isVec(m.gravity, 3)) throw new Error("SimManifest: gravity must be [x,y,z]");
  if (!Array.isArray(m.bodies) || !Array.isArray(m.constraints)) {
    throw new Error("SimManifest: missing bodies/constraints");
  }
  for (const b of m.bodies) {
    if (typeof b.id !== "string" || b.id === "") throw new Error("SimManifest: a body has no id");
    if (typeof b.mass !== "number" || !Number.isFinite(b.mass) || b.mass < 0) {
      throw new Error(`SimManifest: body '${b.id}' has an invalid mass`);
    }
    if (!isVec(b.com, 3)) throw new Error(`SimManifest: body '${b.id}' has an invalid com`);
    if (!isVec(b.orientation, 4)) {
      throw new Error(`SimManifest: body '${b.id}' has an invalid orientation quaternion`);
    }
    if (!Array.isArray(b.colliders) || b.colliders.length === 0) {
      throw new Error(`SimManifest: body '${b.id}' has no colliders`);
    }
    for (const c of b.colliders) {
      if (!Array.isArray(c.points) || c.points.length < 12 || c.points.length % 3 !== 0) {
        throw new Error(`SimManifest: body '${b.id}' has a collider with invalid points`);
      }
      if (!Array.isArray(c.faces) || c.faces.length < 4) {
        throw new Error(`SimManifest: body '${b.id}' has a collider with too few faces`);
      }
      // Every face must be a triangle of in-range vertex indices, or a backend
      // dereferences out of bounds (silent garbage / crash) deep in spawn().
      const vertexCount = c.points.length / 3;
      for (const f of c.faces) {
        if (!Array.isArray(f) || f.length !== 3) {
          throw new Error(`SimManifest: body '${b.id}' has a non-triangular collider face`);
        }
        for (const idx of f) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
            throw new Error(`SimManifest: body '${b.id}' has a collider face index out of range`);
          }
        }
      }
    }
  }
  for (const c of m.constraints) {
    if (c.kind !== "hinge" && c.kind !== "fixed") {
      throw new Error(`SimManifest: constraint has unknown kind '${String(c.kind)}'`);
    }
    // Structural only: the refs must be strings. Whether they resolve to a spawned
    // body is a SEMANTIC check the backend makes at spawn (warn-and-drop), so a
    // dangling ref degrades gracefully rather than failing the whole manifest.
    if (typeof c.bodyA !== "string" || typeof c.bodyB !== "string") {
      throw new Error("SimManifest: a constraint has a non-string body reference");
    }
    if (!isVec(c.origin, 3)) throw new Error(`SimManifest: ${c.kind} constraint has an invalid origin`);
    if (!isVec(c.axis, 3)) throw new Error(`SimManifest: ${c.kind} constraint has an invalid axis`);
  }
  return m;
}
