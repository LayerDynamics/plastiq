// Convex DECOMPOSITION of a part into collision pieces. A single convex hull is
// exact only for convex parts; a concave part (an L-bracket, a dished tray, a
// C-clamp) bulges its hull across the concavity and would collide as if the
// pocket were filled. This splits such a part into a small set of convex pieces
// (a compound collider) that together track the real shape — a multi-piece
// convex *approximation*, tunable by tolerance, not a single bounding hull.
//
// Convex parts (the common case) skip decomposition entirely via a concavity
// gate and keep the fast single-hull path. Concave parts are decomposed with
// V-HACD (Voxelized Hierarchical Approximate Convex Decomposition) — the
// canonical algorithm, vendored at packages/cad/vendor/vhacd (see PROVENANCE.md).

import { ConvexMeshDecomposition } from "../../vendor/vhacd/lib/vhacd.js";
import { cross, dot, sub, type Vec3 } from "../math/index.js";
import { convexHull } from "./hull.js";
import type { HullCollider } from "./manifest.js";

let decomposer: ConvexMeshDecomposition | null = null;
let pending: Promise<ConvexMeshDecomposition> | null = null;

/**
 * Initialize the V-HACD decomposer (loads its wasm). Memoized — safe to call
 * repeatedly. Must complete before {@link collidersFor} decomposes a *concave*
 * part; convex parts need no decomposer. Mirror the OCCT-init pattern: await it
 * once at worker startup / test setup, then call {@link collidersFor} freely.
 */
export async function initDecomposer(): Promise<void> {
  if (decomposer) return;
  pending ??= ConvexMeshDecomposition.create();
  try {
    decomposer = await pending;
  } catch (err) {
    // Don't poison the memo: a transient create() failure must not make every
    // future call re-await the same rejected promise — clear it so a later call
    // can retry. Concurrent awaiters all land here and reset idempotently.
    pending = null;
    throw err;
  }
}

/** True once {@link initDecomposer} has completed. */
export function decomposerReady(): boolean {
  return decomposer !== null;
}

function vertAt(points: readonly number[], i: number): Vec3 {
  return [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!];
}

/**
 * Volume of a CONVEX triangle-mesh hull. Sums the (unsigned) tetrahedra from the
 * mesh centroid to each face — winding-independent, so it is correct even when a
 * hull's triangles aren't consistently wound (our convexHull orients face normals
 * but not vertex order). Valid for convex shapes (every collider is convex), where
 * the centroid is interior and the centroid-fan tetrahedra tile the solid exactly.
 *
 * NOTE: `@plastiq/sim`'s `hullVolume` (in sim/manifest.ts) is the deliberate mirror
 * of this — the two packages stay decoupled (sim never imports cad; the manifest
 * types are hand-mirrored for the same reason), so this algorithm is duplicated
 * rather than shared. Keep the two in lock-step if either changes.
 */
export function meshVolume(points: readonly number[], faces: readonly number[][]): number {
  const n = points.length / 3;
  if (n < 4) return 0;
  let gx = 0,
    gy = 0,
    gz = 0;
  for (let i = 0; i < n; i++) {
    gx += points[3 * i]!;
    gy += points[3 * i + 1]!;
    gz += points[3 * i + 2]!;
  }
  const g: Vec3 = [gx / n, gy / n, gz / n];
  let v = 0;
  for (const f of faces) {
    const a = sub(vertAt(points, f[0]!), g);
    const b = sub(vertAt(points, f[1]!), g);
    const c = sub(vertAt(points, f[2]!), g);
    v += Math.abs(dot(a, cross(b, c)));
  }
  return v / 6;
}

export interface DecomposeOptions {
  /** Max convex pieces per part (V-HACD `maxHulls`). Default 32. */
  maxHulls?: number;
  /** Voxel grid resolution (V-HACD `voxelResolution`). Default 100_000. */
  voxelResolution?: number;
  /**
   * Concavity gate: if the convex hull encloses no more than this fraction of
   * extra volume over the real solid, the part is treated as convex and kept as
   * one hull (no decomposition). Default 0.03 (3%).
   */
  concavityTolerance?: number;
}

const DEFAULT_MAX_HULLS = 32;
const DEFAULT_VOXEL_RESOLUTION = 100_000;
const DEFAULT_CONCAVITY_TOLERANCE = 0.03;

/**
 * Compute a part's collision colliders from its tessellation (COM-local frame).
 *
 * **Precondition:** this is synchronous (it is called from the synchronous
 * lowering path). A *convex* part needs nothing extra. A *concave* part is
 * decomposed with V-HACD, which requires {@link initDecomposer} to have been
 * awaited first — otherwise this **throws** `"collidersFor: initDecomposer() must
 * complete before decomposing a concave part"`. Use {@link decomposerReady} to
 * check. (Callers — the worker and the test setup — `await initDecomposer()` once
 * up front; it is intentionally not lazily initialised here to keep this sync.)
 *
 * @param positions flat vertex triplets `[x,y,z,…]` (the part's tessellation,
 *        centred on its COM)
 * @param indices   triangle indices into `positions`/3
 * @param solidVolume the part's true volume (from mass properties), for the
 *        concavity gate
 * @returns one collider for a convex/near-convex part, or several convex pieces
 *        for a concave part. Never empty.
 */
export function collidersFor(
  positions: readonly number[],
  indices: readonly number[],
  solidVolume: number,
  opts?: DecomposeOptions,
): HullCollider[] {
  // The whole-part convex hull: the collider for convex parts, and the metric
  // for the concavity gate (and the safety fallback below).
  const cloud: Vec3[] = [];
  for (let k = 0; k < positions.length; k += 3) {
    cloud.push([positions[k]!, positions[k + 1]!, positions[k + 2]!]);
  }
  const hull = convexHull(cloud);
  const hullPoints: number[] = [];
  for (const v of hull.vertices) hullPoints.push(v[0], v[1], v[2]);
  const wholeHull: HullCollider = { points: hullPoints, faces: hull.faces.map((f) => [...f]) };

  const hullVolume = meshVolume(hullPoints, wholeHull.faces);
  const tolerance = opts?.concavityTolerance ?? DEFAULT_CONCAVITY_TOLERANCE;
  // Convex / near-convex (or volumes we can't trust) → the single fast hull.
  if (hullVolume <= 0 || solidVolume <= 0 || (hullVolume - solidVolume) / hullVolume <= tolerance) {
    return [wholeHull];
  }

  // Genuinely concave → decompose into convex pieces with V-HACD.
  if (!decomposer) {
    throw new Error(
      "collidersFor: initDecomposer() must complete before decomposing a concave part",
    );
  }
  const pieces = decomposer.computeConvexHulls(
    { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) },
    {
      maxHulls: opts?.maxHulls ?? DEFAULT_MAX_HULLS,
      voxelResolution: opts?.voxelResolution ?? DEFAULT_VOXEL_RESOLUTION,
    },
  );

  const colliders: HullCollider[] = [];
  for (const piece of pieces) {
    const points = Array.from(piece.positions);
    const faces: number[][] = [];
    for (let i = 0; i < piece.indices.length; i += 3) {
      faces.push([piece.indices[i]!, piece.indices[i + 1]!, piece.indices[i + 2]!]);
    }
    // A usable convex piece needs ≥ 4 vertices and ≥ 4 faces.
    if (points.length >= 12 && faces.length >= 4) colliders.push({ points, faces });
  }
  // V-HACD produced nothing usable (degenerate input) → fall back to one hull,
  // so a body is never left with zero colliders.
  return colliders.length > 0 ? colliders : [wholeHull];
}
