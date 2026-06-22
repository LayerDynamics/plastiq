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
