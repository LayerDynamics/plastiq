// M10 — a dense voxel occupancy grid with box edits, 6-neighbor surface culling, and a
// voxels→mesh export. The liftable core of the voxel-editor idea (docs/adr/0010): pure TypeScript,
// deterministic, no dependency. `toMesh` output → a MeshDoc → the existing reconstruct (mesh→B-rep).

export type V3 = readonly [number, number, number];

export interface VoxelMesh {
  /** Flat `[x,y,z, …]` world-space vertices. */
  vertices: number[];
  /** Flat triangle indices into `vertices`. */
  indices: number[];
  /** Optional flat `[x,y,z,…]` per-vertex normals (marching-cubes populates these; the
   * cube-face mesher omits them and lets the renderer compute per-face normals). */
  normals?: number[];
}

const NEIGHBORS: V3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** The 6 cube faces: outward direction + the 4 corner offsets (cell-local [0,1]³), wound CCW from
 * outside so the two triangles `(0,1,2),(0,2,3)` face outward. */
const FACES: { dir: V3; corners: V3[] }[] = [
  { dir: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { dir: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { dir: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

export class VoxelGrid {
  readonly dims: readonly [number, number, number];
  readonly voxelSize: number;
  readonly origin: readonly [number, number, number];
  private readonly cells: Uint8Array;

  constructor(dims: V3, voxelSize = 1, origin: V3 = [0, 0, 0]) {
    this.dims = [dims[0], dims[1], dims[2]];
    this.voxelSize = voxelSize;
    this.origin = [origin[0], origin[1], origin[2]];
    this.cells = new Uint8Array(dims[0] * dims[1] * dims[2]);
  }

  private idx(x: number, y: number, z: number): number {
    return (z * this.dims[1] + y) * this.dims[0] + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.dims[0] && y < this.dims[1] && z < this.dims[2];
  }

  get(x: number, y: number, z: number): boolean {
    return this.inBounds(x, y, z) && this.cells[this.idx(x, y, z)] === 1;
  }

  set(x: number, y: number, z: number, occupied: boolean): void {
    if (this.inBounds(x, y, z)) this.cells[this.idx(x, y, z)] = occupied ? 1 : 0;
  }

  private box(min: V3, max: V3, occupied: boolean): void {
    for (let z = min[2]; z <= max[2]; z++)
      for (let y = min[1]; y <= max[1]; y++)
        for (let x = min[0]; x <= max[0]; x++) this.set(x, y, z, occupied);
  }

  addBox(min: V3, max: V3): void {
    this.box(min, max, true);
  }

  eraseBox(min: V3, max: V3): void {
    this.box(min, max, false);
  }

  count(): number {
    let n = 0;
    for (const c of this.cells) n += c;
    return n;
  }

  /** Linear indices `(z·ny + y)·nx + x` of every occupied cell — the compact VoxelDoc persistence. */
  toIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === 1) out.push(i);
    return out;
  }

  /** Surface voxels: occupied cells with fewer than 6 occupied neighbours (an out-of-bounds neighbour
   * counts as empty, so boundary voxels are always visible) — voxel-editor's `visible() = n != 6`. */
  visibleCells(): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (let z = 0; z < this.dims[2]; z++)
      for (let y = 0; y < this.dims[1]; y++)
        for (let x = 0; x < this.dims[0]; x++) {
          if (!this.get(x, y, z)) continue;
          let occupiedNeighbors = 0;
          for (const [dx, dy, dz] of NEIGHBORS) if (this.get(x + dx, y + dy, z + dz)) occupiedNeighbors++;
          if (occupiedNeighbors < 6) out.push([x, y, z]);
        }
    return out;
  }

  /** Triangle mesh of every exposed voxel face (a face is exposed when its neighbour is empty/OOB).
   * Vertices are world-space; faces are not shared between voxels (simple + deterministic). */
  toMesh(): VoxelMesh {
    const vertices: number[] = [];
    const indices: number[] = [];
    const s = this.voxelSize;
    const [ox, oy, oz] = this.origin;
    for (let z = 0; z < this.dims[2]; z++)
      for (let y = 0; y < this.dims[1]; y++)
        for (let x = 0; x < this.dims[0]; x++) {
          if (!this.get(x, y, z)) continue;
          for (const { dir, corners } of FACES) {
            if (this.get(x + dir[0], y + dir[1], z + dir[2])) continue; // neighbour fills it → hidden
            const base = vertices.length / 3;
            for (const [cx, cy, cz] of corners) {
              vertices.push(ox + (x + cx) * s, oy + (y + cy) * s, oz + (z + cz) * s);
            }
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
    return { vertices, indices };
  }
}
