// §16 Phase 4 — the sculpt brush set. Seven brushes, each a pure `VoxelDoc → VoxelDoc`
// transform (the store's declared edit contract) parameterized by radius / strength /
// falloff, plus mirror-symmetry planes. They operate on the narrow-band SDF (voxel/
// sdf.ts): a brush only touches cells whose CENTRE lies within `radius` of the brush
// centre, so its effect is strictly local and deterministic.
//
//   draw     — deposit a rounded bump of material (soft union with a sphere)
//   clay     — build material up to a surface-following plane (flat-topped deposit)
//   smooth   — blur the field toward its neighbourhood mean (lowers curvature/variance)
//   flatten  — pull the surface toward the brush plane
//   inflate  — push the surface outward along its normal (uniform thickening)
//   pinch    — draw material toward the brush centre (sharpen)
//   grab     — translate a blob of surface along a drag vector
//
// The ray entry point stays sculptAt/rayVoxelHit (voxel/pick.ts): the store resolves a
// world-space brush centre from a camera ray, then calls applyBrushToDoc.

import type { V3 } from "./grid.js";
import type { VoxelDoc } from "../store/types.js";
import { sdfFromDoc } from "./sdf.js";
import type { SdfGrid } from "./sdf.js";

export type BrushType = "draw" | "clay" | "smooth" | "flatten" | "inflate" | "pinch" | "grab";

/** Closed list of §16 SDF brushes — used by the store, ribbon, and tool guards. */
export const BRUSH_TYPES: readonly BrushType[] = [
  "draw",
  "clay",
  "smooth",
  "flatten",
  "inflate",
  "pinch",
  "grab",
] as const;

export type Falloff = "smooth" | "linear" | "constant";

/** A mirror plane at world `coord` on the given axis (0=X, 1=Y, 2=Z). */
export interface MirrorPlane {
  axis: 0 | 1 | 2;
  coord: number;
}

export interface BrushSpec {
  type: BrushType;
  /** World-space brush centre (resolved from a ray hit). */
  center: V3;
  /** Brush radius in metres. */
  radius: number;
  /** Signed dimensionless strength multiplier (negative subtracts). */
  strength: number;
  /** Falloff profile from centre (default "smooth"). */
  falloff?: Falloff;
  /** Surface normal at the centre (flatten/clay/inflate direction; default +Z). */
  normal?: V3;
  /** Drag vector for the grab brush (world metres; default none = no move). */
  delta?: V3;
  /** Mirror-symmetry planes; the brush is also applied at every reflection. */
  mirror?: MirrorPlane[];
}

/** Falloff weight in [0,1] for a cell at distance `d` from a brush of radius `r`. */
export function falloffWeight(d: number, r: number, kind: Falloff): number {
  if (r <= 0 || d >= r) return 0;
  const t = 1 - d / r; // 1 at centre → 0 at rim
  switch (kind) {
    case "constant":
      return 1;
    case "linear":
      return t;
    case "smooth":
    default:
      return t * t * (3 - 2 * t); // smoothstep
  }
}

/** Reflect a world point across a mirror plane. */
function reflectPoint(p: V3, plane: MirrorPlane): V3 {
  const out: [number, number, number] = [p[0], p[1], p[2]];
  out[plane.axis] = 2 * plane.coord - p[plane.axis];
  return out;
}

/** Reflect a direction/vector across a mirror plane (flip its component on the axis). */
function reflectVec(v: V3, plane: MirrorPlane): V3 {
  const out: [number, number, number] = [v[0], v[1], v[2]];
  out[plane.axis] = -v[plane.axis];
  return out;
}

/** Every reflection of `spec` across all 2^k combinations of the mirror planes. */
function mirroredSpecs(spec: BrushSpec): BrushSpec[] {
  const planes = spec.mirror ?? [];
  let specs: BrushSpec[] = [spec];
  for (const plane of planes) {
    const next: BrushSpec[] = [];
    for (const s of specs) {
      next.push(s);
      next.push({
        ...s,
        center: reflectPoint(s.center, plane),
        ...(s.normal ? { normal: reflectVec(s.normal, plane) } : {}),
        ...(s.delta ? { delta: reflectVec(s.delta, plane) } : {}),
      });
    }
    specs = next;
  }
  return specs;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/** Apply one brush (already reflected) in place on the grid, reading from `snapshot`. */
function applyOne(g: SdfGrid, spec: BrushSpec, snapshot: Float32Array): void {
  const s = g.voxelSize;
  const r = spec.radius;
  const falloff = spec.falloff ?? "smooth";
  const [cx, cy, cz] = spec.center;
  const n = spec.normal ? norm(spec.normal) : ([0, 0, 1] as V3);
  const band = g.band;

  // World AABB of the brush → the cell-index window it can touch.
  const lo = worldToCell(g, [cx - r, cy - r, cz - r], Math.floor);
  const hi = worldToCell(g, [cx + r, cy + r, cz + r], Math.ceil);

  const sampleSnapshot = (p: V3): number => sampleField(g, snapshot, p);

  for (let z = Math.max(0, lo[2]); z <= Math.min(g.dims[2] - 1, hi[2]); z++)
    for (let y = Math.max(0, lo[1]); y <= Math.min(g.dims[1] - 1, hi[1]); y++)
      for (let x = Math.max(0, lo[0]); x <= Math.min(g.dims[0] - 1, hi[0]); x++) {
        const p = g.world(x, y, z);
        const d = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
        if (d >= r) continue; // strictly local
        const w = falloffWeight(d, r, falloff);
        if (w === 0) continue;
        const i = g.idx(x, y, z);
        const f = g.field[i]!;
        let out = f;
        switch (spec.type) {
          case "draw": {
            // Soft union with a deposited sphere of radius |strength|·r about the centre.
            const sphere = d - Math.abs(spec.strength) * r;
            const target = spec.strength >= 0 ? Math.min(f, sphere) : Math.max(f, -sphere);
            out = lerp(f, target, w);
            break;
          }
          case "clay": {
            // Build up to a plane a little outside the surface (flat-topped deposit),
            // bounded to the brush disc.
            const height = spec.strength * s * 2;
            const planeDist = dot(
              sub(p, [cx + n[0] * height, cy + n[1] * height, cz + n[2] * height]),
              n,
            );
            const bounded = Math.max(planeDist, d - r);
            const target = spec.strength >= 0 ? Math.min(f, bounded) : Math.max(f, -bounded);
            out = lerp(f, target, w);
            break;
          }
          case "inflate": {
            out = f - spec.strength * s * 2 * w; // push the level-set outward (in) along ∇f
            break;
          }
          case "flatten": {
            const planeDist = dot(sub(p, spec.center), n);
            out = lerp(f, planeDist, w * clamp01(Math.abs(spec.strength)));
            break;
          }
          case "smooth": {
            const avg = neighbourhoodMean(g, snapshot, x, y, z);
            out = lerp(sampleSnapshot(p), avg, w * clamp01(Math.abs(spec.strength)));
            break;
          }
          case "pinch": {
            // Pull the sample point toward the centre → material converges (sharpen).
            const k = w * clamp01(Math.abs(spec.strength)) * 0.5;
            const pp: V3 = [p[0] + (cx - p[0]) * k, p[1] + (cy - p[1]) * k, p[2] + (cz - p[2]) * k];
            out = sampleSnapshot(pp);
            break;
          }
          case "grab": {
            const dl = spec.delta ?? [0, 0, 0];
            const pp: V3 = [p[0] - dl[0] * w, p[1] - dl[1] * w, p[2] - dl[2] * w];
            out = sampleSnapshot(pp);
            break;
          }
        }
        g.field[i] = clamp(out, -band, band);
      }
}

/** Apply a brush (and all its mirror reflections) to an SdfGrid, in place. */
export function applyBrushToSdf(g: SdfGrid, spec: BrushSpec): void {
  const snapshot = new Float32Array(g.field); // pre-brush field for resample brushes
  for (const s of mirroredSpecs(spec)) applyOne(g, s, snapshot);
}

/** Pure `VoxelDoc → VoxelDoc`: sculpt the doc's SDF with `spec` and re-sync occupancy. */
export function applyBrushToDoc(doc: VoxelDoc, spec: BrushSpec): VoxelDoc {
  const g = sdfFromDoc(doc);
  applyBrushToSdf(g, spec);
  const next = g.toDoc(doc.name);
  return next;
}

// --- field sampling helpers -------------------------------------------------

function worldToCell(g: SdfGrid, p: V3, round: (n: number) => number): [number, number, number] {
  const s = g.voxelSize;
  return [
    round((p[0] - g.origin[0]) / s - 0.5),
    round((p[1] - g.origin[1]) / s - 0.5),
    round((p[2] - g.origin[2]) / s - 0.5),
  ];
}

/** Trilinear sample of an explicit field array laid over grid `g`, clamped to bounds. */
function sampleField(g: SdfGrid, field: Float32Array, p: V3): number {
  const s = g.voxelSize;
  const fx = (p[0] - g.origin[0]) / s - 0.5;
  const fy = (p[1] - g.origin[1]) / s - 0.5;
  const fz = (p[2] - g.origin[2]) / s - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;
  const at = (x: number, y: number, z: number): number => {
    const cx = clampI(x, 0, g.dims[0] - 1);
    const cy = clampI(y, 0, g.dims[1] - 1);
    const cz = clampI(z, 0, g.dims[2] - 1);
    return field[g.idx(cx, cy, cz)]!;
  };
  const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;
  const x00 = lerpN(at(x0, y0, z0), at(x0 + 1, y0, z0), tx);
  const x10 = lerpN(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx);
  const x01 = lerpN(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx);
  const x11 = lerpN(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx);
  return lerpN(lerpN(x00, x10, ty), lerpN(x01, x11, ty), tz);
}

/** Mean of the 6-neighbourhood (in-bounds) field values at cell (x,y,z). */
function neighbourhoodMean(
  g: SdfGrid,
  field: Float32Array,
  x: number,
  y: number,
  z: number,
): number {
  let sum = field[g.idx(x, y, z)]!;
  let count = 1;
  const off: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const [dx, dy, dz] of off) {
    const xx = x + dx;
    const yy = y + dy;
    const zz = z + dz;
    if (g.inBounds(xx, yy, zz)) {
      sum += field[g.idx(xx, yy, zz)]!;
      count++;
    }
  }
  return sum / count;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function clampI(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
