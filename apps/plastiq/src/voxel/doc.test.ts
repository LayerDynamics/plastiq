// M10 — VoxelGrid ↔ VoxelDoc round-trip + the mesh handoff to reconstruct.

import { describe, expect, it } from "vitest";

import { isVoxelDoc } from "../store/types.js";
import { docToGrid, gridToDoc, voxelDocToMesh } from "./doc.js";
import { VoxelGrid } from "./grid.js";

describe("VoxelDoc round-trip", () => {
  it("grid → doc → grid preserves the occupancy", () => {
    const g = new VoxelGrid([6, 6, 6], 2, [1, 0, -1]);
    g.addBox([1, 1, 1], [3, 2, 4]);
    g.set(5, 5, 5, true);
    const doc = gridToDoc(g, "sculpt");
    expect(isVoxelDoc(doc)).toBe(true);
    expect(doc.name).toBe("sculpt");
    expect(doc.cells.length).toBe(g.count());

    const back = docToGrid(doc);
    expect(back.count()).toBe(g.count());
    expect(back.get(1, 1, 1)).toBe(true);
    expect(back.get(3, 2, 4)).toBe(true);
    expect(back.get(5, 5, 5)).toBe(true);
    expect(back.get(0, 0, 0)).toBe(false);
    expect(back.voxelSize).toBe(2);
    expect(back.origin).toEqual([1, 0, -1]);
  });

  it("voxelDocToMesh produces the surface mesh for reconstruct", () => {
    const g = new VoxelGrid([3, 3, 3]);
    g.addBox([0, 0, 0], [2, 2, 2]); // solid block
    const mesh = voxelDocToMesh(gridToDoc(g));
    expect(mesh.indices.length / 3).toBe(6 * 9 * 2); // exterior faces only
    expect(mesh.vertices.length).toBeGreaterThan(0);
  });
});
