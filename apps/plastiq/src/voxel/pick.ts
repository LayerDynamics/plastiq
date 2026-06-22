// M10 — voxel ray-pick: a grid raycast for add/erase, and a ray ∩ work-plane → cell for placing on
// an empty plane. Pure TypeScript, deterministic (docs/adr/0010). The liftable voxel-editor idea.

import type { V3, VoxelGrid } from "./grid.js";

export interface VoxelHit {
  /** The first occupied cell the ray enters. */
  cell: [number, number, number];
  /** The outward face normal it entered through — so `cell + normal` is where a new voxel is added. */
  normal: [number, number, number];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * March a ray through the grid (Amanatides–Woo DDA) and return the first occupied cell plus the face
 * normal it entered through. `null` if it leaves the grid without a hit. The ray's start/direction are
 * in world space; direction need not be unit length.
 */
export function rayVoxelHit(grid: VoxelGrid, origin: V3, dir: V3, maxSteps = 1024): VoxelHit | null {
  const s = grid.voxelSize;
  // ray in grid (cell) coordinates
  const o: V3 = [(origin[0] - grid.origin[0]) / s, (origin[1] - grid.origin[1]) / s, (origin[2] - grid.origin[2]) / s];
  let [x, y, z] = [Math.floor(o[0]), Math.floor(o[1]), Math.floor(o[2])];
  const stepX = Math.sign(dir[0]);
  const stepY = Math.sign(dir[1]);
  const stepZ = Math.sign(dir[2]);
  const tDeltaX = dir[0] !== 0 ? Math.abs(1 / dir[0]) : Infinity;
  const tDeltaY = dir[1] !== 0 ? Math.abs(1 / dir[1]) : Infinity;
  const tDeltaZ = dir[2] !== 0 ? Math.abs(1 / dir[2]) : Infinity;
  // distance to the first cell boundary on each axis
  const boundary = (d: number, oc: number, c: number): number =>
    d === 0 ? Infinity : (d > 0 ? c + 1 - oc : oc - c) / Math.abs(d);
  let tMaxX = boundary(dir[0], o[0], x);
  let tMaxY = boundary(dir[1], o[1], y);
  let tMaxZ = boundary(dir[2], o[2], z);
  let normal: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < maxSteps; i++) {
    if (grid.get(x, y, z)) return { cell: [x, y, z], normal };
    // already left the grid and moving further out on every axis → no hit possible
    const outX = (x < 0 && stepX <= 0) || (x >= grid.dims[0] && stepX >= 0);
    const outY = (y < 0 && stepY <= 0) || (y >= grid.dims[1] && stepY >= 0);
    const outZ = (z < 0 && stepZ <= 0) || (z >= grid.dims[2] && stepZ >= 0);
    if (outX && outY && outZ) return null;

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      z += stepZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }
  }
  return null;
}

/**
 * Intersect a ray with a work plane and return the grid cell at the hit point (for placing a voxel on
 * an empty plane). `null` if the ray is parallel to the plane, points away, or the hit is off-grid.
 */
export function rayWorkPlaneCell(
  grid: VoxelGrid,
  origin: V3,
  dir: V3,
  plane: { point: V3; normal: V3 },
): [number, number, number] | null {
  const denom = dot(dir, plane.normal);
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const t = dot(sub(plane.point, origin), plane.normal) / denom;
  if (t < 0) return null; // behind the ray
  const p: V3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const s = grid.voxelSize;
  const cell: [number, number, number] = [
    Math.floor((p[0] - grid.origin[0]) / s),
    Math.floor((p[1] - grid.origin[1]) / s),
    Math.floor((p[2] - grid.origin[2]) / s),
  ];
  return grid.inBounds(cell[0], cell[1], cell[2]) ? cell : null;
}
