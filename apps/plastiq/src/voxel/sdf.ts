// §16 Phase 4 — the signed-distance field that replaces raw occupancy as the sculpt
// engine's geometric truth (pure TS, deterministic; docs/adr/0010 framing).
//
// An `SdfGrid` stores one signed distance per grid CELL CENTRE in a narrow-band
// `Float32Array` (metres; negative INSIDE the surface, positive outside, saturated to
// ±band). Marching cubes (marchingCubes.ts) meshes its zero level-set into a smooth,
// watertight surface — a strict upgrade over the 6-neighbour cube-face mesher for the
// convert-to-CAD / NURBS-fit route, whose input quality now improves.
//
// It bridges to the persisted `VoxelDoc` both ways:
//   • `fromDoc`  — a v2 doc restores its stored field; a legacy (v1, occupancy-only)
//                  doc is MIGRATED by computing a signed chamfer distance transform of
//                  its occupied cells (the schema-version migration path).
//   • `toDoc`    — writes the field back plus a synced occupancy shadow (`cells` =
//                  the cells whose distance is negative), so every existing consumer
//                  that reads `doc.cells.length` keeps working unchanged.
//
// A B-rep body enters the sculpt lane through `fromMesh`: a pure-TS mesh distance
// field (closest-point-on-triangle magnitude, generalized-winding-number sign) bakes a
// tessellated mesh into an SDF so any solid can be sculpt-refined (CAD→sculpt bridge).

import type { V3 } from "./grid.js";
import { VoxelGrid } from "./grid.js";
import type { VoxelDoc, VoxelSdf } from "../store/types.js";
import { marchingCubes, type ScalarField } from "./marchingCubes.js";
import type { VoxelMesh } from "./grid.js";

/** Default narrow-band half-width, in voxel units, when one is not supplied. */
export const DEFAULT_BAND_VOXELS = 3;

export class SdfGrid {
  readonly dims: readonly [number, number, number];
  readonly voxelSize: number;
  readonly origin: readonly [number, number, number];
  /** Narrow-band half-width in METRES; |field| saturates here. */
  readonly band: number;
  /** Signed distance (metres) per cell centre, laid out `(z·ny + y)·nx + x`. */
  readonly field: Float32Array;

  constructor(dims: V3, voxelSize: number, origin: V3, band: number, field?: Float32Array) {
    this.dims = [dims[0], dims[1], dims[2]];
    this.voxelSize = voxelSize;
    this.origin = [origin[0], origin[1], origin[2]];
    this.band = band;
    const n = dims[0] * dims[1] * dims[2];
    if (field) {
      if (field.length !== n) throw new Error(`SdfGrid: field length ${field.length} ≠ ${n} cells`);
      this.field = field;
    } else {
      this.field = new Float32Array(n).fill(band); // all-outside (empty)
    }
  }

  get cellCount(): number {
    return this.dims[0] * this.dims[1] * this.dims[2];
  }

  idx(x: number, y: number, z: number): number {
    return (z * this.dims[1] + y) * this.dims[0] + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.dims[0] && y < this.dims[1] && z < this.dims[2];
  }

  /** Signed distance at integer cell (clamped read: out-of-bounds ⇒ +band, i.e. empty). */
  at(x: number, y: number, z: number): number {
    return this.inBounds(x, y, z) ? this.field[this.idx(x, y, z)]! : this.band;
  }

  /** Set + clamp a cell's signed distance to the band. */
  setAt(x: number, y: number, z: number, value: number): void {
    if (this.inBounds(x, y, z)) this.field[this.idx(x, y, z)] = clamp(value, -this.band, this.band);
  }

  /** World-space centre of cell (x,y,z). */
  world(x: number, y: number, z: number): [number, number, number] {
    const s = this.voxelSize;
    return [this.origin[0] + (x + 0.5) * s, this.origin[1] + (y + 0.5) * s, this.origin[2] + (z + 0.5) * s];
  }

  /** Trilinear sample of the field at an arbitrary WORLD point (clamped to the grid). */
  sampleWorld(p: V3): number {
    const s = this.voxelSize;
    // Continuous cell-centre coordinates: cell i's centre is at origin+(i+0.5)s.
    const fx = (p[0] - this.origin[0]) / s - 0.5;
    const fy = (p[1] - this.origin[1]) / s - 0.5;
    const fz = (p[2] - this.origin[2]) / s - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    const c = (x: number, y: number, z: number): number =>
      this.at(clampInt(x, 0, this.dims[0] - 1), clampInt(y, 0, this.dims[1] - 1), clampInt(z, 0, this.dims[2] - 1));
    const c000 = c(x0, y0, z0);
    const c100 = c(x0 + 1, y0, z0);
    const c010 = c(x0, y0 + 1, z0);
    const c110 = c(x0 + 1, y0 + 1, z0);
    const c001 = c(x0, y0, z0 + 1);
    const c101 = c(x0 + 1, y0, z0 + 1);
    const c011 = c(x0, y0 + 1, z0 + 1);
    const c111 = c(x0 + 1, y0 + 1, z0 + 1);
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const x00 = lerp(c000, c100, tx);
    const x10 = lerp(c010, c110, tx);
    const x01 = lerp(c001, c101, tx);
    const x11 = lerp(c011, c111, tx);
    return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
  }

  clone(): SdfGrid {
    return new SdfGrid(
      [this.dims[0], this.dims[1], this.dims[2]],
      this.voxelSize,
      [this.origin[0], this.origin[1], this.origin[2]],
      this.band,
      new Float32Array(this.field),
    );
  }

  /** Adapter to the marching-cubes field: one sample per cell centre. */
  toField(): ScalarField {
    return {
      nx: this.dims[0],
      ny: this.dims[1],
      nz: this.dims[2],
      sample: (x, y, z) => this.field[this.idx(x, y, z)]!,
      world: (x, y, z) => this.world(x, y, z),
    };
  }

  /** Marching-cubes the zero level-set → a welded, normal-carrying VoxelMesh. */
  toMesh(iso = 0): VoxelMesh {
    return marchingCubes(this.toField(), iso);
  }

  /** Linear indices of the INSIDE cells (distance < 0) — the occupancy shadow. */
  occupiedCells(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.field.length; i++) if (this.field[i]! < 0) out.push(i);
    return out;
  }

  /** Persist as a v2 VoxelDoc: the field + band, plus the synced occupancy `cells`. */
  toDoc(name?: string): VoxelDoc {
    const sdf: VoxelSdf = { field: Array.from(this.field), band: this.band };
    return {
      kind: "voxel",
      version: 2,
      ...(name ? { name } : {}),
      dims: [this.dims[0], this.dims[1], this.dims[2]],
      voxelSize: this.voxelSize,
      origin: [this.origin[0], this.origin[1], this.origin[2]],
      cells: this.occupiedCells(),
      sdf,
    };
  }

  // --- constructors ---------------------------------------------------------

  /** An empty field (everywhere +band). */
  static empty(dims: V3, voxelSize: number, origin: V3, band?: number): SdfGrid {
    return new SdfGrid(dims, voxelSize, origin, band ?? voxelSize * DEFAULT_BAND_VOXELS);
  }

  /** An analytic sphere SDF: distance to a sphere of `radius` (metres) about world `center`. */
  static sphere(dims: V3, voxelSize: number, origin: V3, center: V3, radius: number, band?: number): SdfGrid {
    const g = SdfGrid.empty(dims, voxelSize, origin, band);
    for (let z = 0; z < g.dims[2]; z++)
      for (let y = 0; y < g.dims[1]; y++)
        for (let x = 0; x < g.dims[0]; x++) {
          const [wx, wy, wz] = g.world(x, y, z);
          const d = Math.hypot(wx - center[0], wy - center[1], wz - center[2]) - radius;
          g.field[g.idx(x, y, z)] = clamp(d, -g.band, g.band);
        }
    return g;
  }

  /**
   * Migrate a dense occupancy grid to a narrow-band SDF via a bounded chamfer distance
   * transform: seed the occupied/empty interface at ±½ voxel, then propagate Euclidean
   * step costs through the 26-neighbourhood (forward+backward sweeps) and sign by
   * occupancy. Deterministic; |field| saturates at `band`.
   */
  static fromOccupancy(grid: VoxelGrid, band?: number): SdfGrid {
    const dims: V3 = [grid.dims[0], grid.dims[1], grid.dims[2]];
    const s = grid.voxelSize;
    const b = band ?? s * DEFAULT_BAND_VOXELS;
    const out = new SdfGrid(dims, s, [grid.origin[0], grid.origin[1], grid.origin[2]], b);
    const [nx, ny, nz] = dims;
    const occ = (x: number, y: number, z: number): boolean => grid.get(x, y, z);
    const u = new Float32Array(nx * ny * nz).fill(b); // unsigned distance
    const idx = (x: number, y: number, z: number): number => (z * ny + y) * nx + x;

    // Seed the interface: a cell touching the opposite region across a face is ½ voxel
    // from the surface (an out-of-bounds neighbour counts as empty).
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const here = occ(x, y, z);
          let surface = false;
          for (const [dx, dy, dz] of FACE6) {
            if (occ(x + dx, y + dy, z + dz) !== here) {
              surface = true;
              break;
            }
          }
          if (surface) u[idx(x, y, z)] = 0.5 * s;
        }

    // Chamfer relaxation over the 26-neighbourhood; enough sweeps to fill the band.
    const passes = Math.max(2, Math.ceil(b / s) + 1);
    for (let pass = 0; pass < passes; pass++) {
      const forward = pass % 2 === 0;
      const xs = range(nx, forward);
      const ys = range(ny, forward);
      const zs = range(nz, forward);
      for (const z of zs)
        for (const y of ys)
          for (const x of xs) {
            let best = u[idx(x, y, z)]!;
            for (const [dx, dy, dz, cost] of NEIGH26) {
              const xx = x + dx;
              const yy = y + dy;
              const zz = z + dz;
              if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
              const cand = u[idx(xx, yy, zz)]! + cost * s;
              if (cand < best) best = cand;
            }
            if (best < u[idx(x, y, z)]!) u[idx(x, y, z)] = best;
          }
    }

    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const i = idx(x, y, z);
          const dist = Math.min(u[i]!, b);
          out.field[i] = occ(x, y, z) ? -dist : dist;
        }
    return out;
  }

  /**
   * Bake a triangle mesh into a narrow-band SDF (the CAD→sculpt bridge). Unsigned
   * distance is the closest-point-on-triangle magnitude; the sign is the generalized
   * winding number (robust for a closed mesh: |Ω/4π| > ½ ⇒ inside). Pure TS.
   *
   * `positions` is flat `[x,y,z,…]`, `indices` groups of three. A bounding grid is
   * chosen from the mesh extent plus a margin unless dims/origin are supplied.
   */
  static fromMesh(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    opts: { voxelSize: number; band?: number; margin?: number; dims?: V3; origin?: V3 },
  ): SdfGrid {
    const s = opts.voxelSize;
    const band = opts.band ?? s * DEFAULT_BAND_VOXELS;
    // Grid bounds.
    let dims = opts.dims;
    let origin = opts.origin;
    if (!dims || !origin) {
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = positions[i + a]!;
          if (v < min[a]!) min[a] = v;
          if (v > max[a]!) max[a] = v;
        }
      }
      const margin = (opts.margin ?? 2) * s;
      origin = [min[0] - margin, min[1] - margin, min[2] - margin];
      dims = [
        Math.max(2, Math.ceil((max[0] - min[0] + 2 * margin) / s)),
        Math.max(2, Math.ceil((max[1] - min[1] + 2 * margin) / s)),
        Math.max(2, Math.ceil((max[2] - min[2] + 2 * margin) / s)),
      ];
    }
    const out = new SdfGrid(dims, s, origin, band);
    const tris = Math.floor(indices.length / 3);

    for (let z = 0; z < out.dims[2]; z++)
      for (let y = 0; y < out.dims[1]; y++)
        for (let x = 0; x < out.dims[0]; x++) {
          const p = out.world(x, y, z);
          let best = Infinity;
          let omega = 0; // solid-angle accumulator (generalized winding number × 4π)
          for (let t = 0; t < tris; t++) {
            const ia = indices[t * 3]! * 3;
            const ib = indices[t * 3 + 1]! * 3;
            const ic = indices[t * 3 + 2]! * 3;
            const a: V3 = [positions[ia]!, positions[ia + 1]!, positions[ia + 2]!];
            const bb: V3 = [positions[ib]!, positions[ib + 1]!, positions[ib + 2]!];
            const cc: V3 = [positions[ic]!, positions[ic + 1]!, positions[ic + 2]!];
            const d = pointTriangleDistance(p, a, bb, cc);
            if (d < best) best = d;
            omega += solidAngle(p, a, bb, cc);
          }
          const inside = Math.abs(omega / (4 * Math.PI)) > 0.5;
          out.field[out.idx(x, y, z)] = clamp(inside ? -best : best, -band, band);
        }
    return out;
  }
}

/** Build an SdfGrid from a persisted VoxelDoc: v2 restores the field; v1 migrates. */
export function sdfFromDoc(doc: VoxelDoc, band?: number): SdfGrid {
  if (doc.sdf) {
    const f = Float32Array.from(doc.sdf.field);
    return new SdfGrid(doc.dims, doc.voxelSize, doc.origin, doc.sdf.band, f);
  }
  // Legacy occupancy doc → migrate. Re-derive the grid from the compact cell indices.
  const grid = new VoxelGrid(doc.dims, doc.voxelSize, doc.origin);
  const [nx, ny] = doc.dims;
  for (const i of doc.cells) {
    const x = i % nx;
    const rem = Math.floor(i / nx);
    grid.set(x, rem % ny, Math.floor(rem / ny), true);
  }
  return SdfGrid.fromOccupancy(grid, band);
}

// --- geometry helpers -------------------------------------------------------

const FACE6: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** All 26 neighbour offsets with their Euclidean step lengths (1, √2, √3). */
const NEIGH26: ReadonlyArray<readonly [number, number, number, number]> = (() => {
  const out: [number, number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        out.push([dx, dy, dz, Math.hypot(dx, dy, dz)]);
      }
  return out;
})();

function range(n: number, forward: boolean): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = forward ? i : n - 1 - i;
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Squared distance from point `p` to the triangle (a,b,c); returns the distance. */
export function pointTriangleDistance(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len(ap); // vertex A

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp); // vertex B

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return len(sub(p, add(a, scale(ab, v)))); // edge AB
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp); // vertex C

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return len(sub(p, add(a, scale(ac, w)))); // edge AC
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return len(sub(p, add(b, scale(sub(c, b), w)))); // edge BC
  }

  // Interior of the face.
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return len(sub(p, add(a, add(scale(ab, v), scale(ac, w)))));
}

/** Signed solid angle subtended at `p` by triangle (a,b,c) — the winding-number term. */
export function solidAngle(p: V3, a: V3, b: V3, c: V3): number {
  const av = sub(a, p);
  const bv = sub(b, p);
  const cv = sub(c, p);
  const la = len(av);
  const lb = len(bv);
  const lc = len(cv);
  if (la < 1e-20 || lb < 1e-20 || lc < 1e-20) return 0;
  const numer = det3(av, bv, cv);
  const denom = la * lb * lc + dot(av, bv) * lc + dot(bv, cv) * la + dot(cv, av) * lb;
  return 2 * Math.atan2(numer, denom);
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, t: number): V3 => [a[0] * t, a[1] * t, a[2] * t];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const det3 = (a: V3, b: V3, c: V3): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
