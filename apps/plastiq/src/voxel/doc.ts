// M10 — convert between a live VoxelGrid and the compact persisted VoxelDoc (store/types.ts), and a
// grid → mesh handoff (docs/adr/0010). A VoxelDoc's surface mesh becomes a MeshDoc → reconstruct.

import type { VoxelDoc } from "../store/types.js";
import { VoxelGrid, type VoxelMesh } from "./grid.js";

/** Snapshot a grid into a persistable VoxelDoc (occupied cells stored as linear indices). */
export function gridToDoc(grid: VoxelGrid, name?: string): VoxelDoc {
  return {
    kind: "voxel",
    ...(name ? { name } : {}),
    dims: [grid.dims[0], grid.dims[1], grid.dims[2]],
    voxelSize: grid.voxelSize,
    origin: [grid.origin[0], grid.origin[1], grid.origin[2]],
    cells: grid.toIndices(),
  };
}

/** Re-derive a live grid from a persisted VoxelDoc. */
export function docToGrid(doc: VoxelDoc): VoxelGrid {
  const [nx, ny] = doc.dims;
  const grid = new VoxelGrid(doc.dims, doc.voxelSize, doc.origin);
  for (const i of doc.cells) {
    const x = i % nx;
    const rem = Math.floor(i / nx);
    grid.set(x, rem % ny, Math.floor(rem / ny), true);
  }
  return grid;
}

/** The surface mesh of a voxel document — the input to the existing mesh→B-rep reconstruct path. */
export function voxelDocToMesh(doc: VoxelDoc): VoxelMesh {
  return docToGrid(doc).toMesh();
}

/** Default sculpt grid: 32³ cells at 2 mm (SI metres) → a 64 mm working cube, matching the
 * seeded parametric box's scale (store/seed.ts). Origin centres the grid on the XY ground
 * plane (Z-up, grid base at z=0). Seeded with a small central slab so a fresh sculpt shows
 * geometry immediately (the seed.ts philosophy) and the first click has a surface to hit. */
export function defaultVoxelDoc(name?: string): VoxelDoc {
  const grid = new VoxelGrid([32, 32, 32], 0.002, [-0.032, -0.032, 0]);
  grid.addBox([12, 12, 0], [19, 19, 1]); // an 8×8×2 starter slab at the centre of the floor
  return gridToDoc(grid, name ?? "Voxel Sculpt");
}
