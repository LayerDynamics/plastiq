// M10 — VoxelGrid: dense occupancy + box edits + 6-neighbor surface cull + voxels→mesh.
// The liftable core of the voxel-editor idea (docs/adr/0010). Pure, deterministic.

import { describe, expect, it } from "vitest";

import { VoxelGrid } from "./grid.js";

describe("VoxelGrid", () => {
  it("starts empty and round-trips set/get", () => {
    const g = new VoxelGrid([4, 4, 4]);
    expect(g.count()).toBe(0);
    expect(g.get(1, 2, 3)).toBe(false);
    g.set(1, 2, 3, true);
    expect(g.get(1, 2, 3)).toBe(true);
    expect(g.count()).toBe(1);
  });

  it("addBox fills an inclusive cell range; eraseBox clears it", () => {
    const g = new VoxelGrid([8, 8, 8]);
    g.addBox([1, 1, 1], [2, 3, 4]); // 2×3×4 = 24 cells
    expect(g.count()).toBe(24);
    expect(g.get(1, 1, 1)).toBe(true);
    expect(g.get(2, 3, 4)).toBe(true);
    g.eraseBox([1, 1, 1], [2, 3, 4]);
    expect(g.count()).toBe(0);
  });

  it("ignores out-of-bounds writes", () => {
    const g = new VoxelGrid([2, 2, 2]);
    g.set(5, 5, 5, true);
    expect(g.count()).toBe(0);
    expect(g.inBounds(5, 5, 5)).toBe(false);
  });

  it("6-neighbor cull hides the fully-enclosed voxel in a 3×3×3 block", () => {
    const g = new VoxelGrid([3, 3, 3]);
    g.addBox([0, 0, 0], [2, 2, 2]); // 27 cells; the centre (1,1,1) has all 6 neighbours filled
    expect(g.count()).toBe(27);
    const visible = g.visibleCells();
    expect(visible).toHaveLength(26); // 27 − the hidden centre
    expect(visible.some(([x, y, z]) => x === 1 && y === 1 && z === 1)).toBe(false);
  });

  it("toMesh emits the 6 exposed faces of a lone voxel (12 triangles)", () => {
    const g = new VoxelGrid([3, 3, 3], 1, [0, 0, 0]);
    g.set(1, 1, 1, true);
    const mesh = g.toMesh();
    expect(mesh.indices.length).toBe(6 * 2 * 3); // 6 faces × 2 triangles × 3 indices = 36
    expect(mesh.vertices.length).toBe(6 * 4 * 3); // 6 faces × 4 verts × 3 coords = 72
    // the voxel occupies the world cube [1,2]³ at voxelSize 1
    const xs = mesh.vertices.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...xs)).toBeCloseTo(2);
  });

  it("toMesh of a solid block emits only its exterior faces", () => {
    const g = new VoxelGrid([3, 3, 3]);
    g.addBox([0, 0, 0], [2, 2, 2]); // a solid 3×3×3 cube → exterior = 6 faces × 9 cells
    const tris = g.toMesh().indices.length / 3;
    expect(tris).toBe(6 * 9 * 2); // 6 sides × 9 quads × 2 triangles = 108 (no interior faces)
  });
});
