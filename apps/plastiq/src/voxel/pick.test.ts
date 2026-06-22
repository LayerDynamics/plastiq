// M10 — voxel ray-pick: DDA voxel raycast (first hit + face normal, for add/erase) and ray ∩
// work-plane → grid cell (for placing on an empty plane). Pure, deterministic (docs/adr/0010).

import { describe, expect, it } from "vitest";

import { VoxelGrid } from "./grid.js";
import { rayVoxelHit, rayWorkPlaneCell } from "./pick.js";

describe("rayVoxelHit", () => {
  it("hits a voxel from above and reports the top (+z) face", () => {
    const g = new VoxelGrid([10, 10, 10]);
    g.set(5, 5, 0, true);
    const hit = rayVoxelHit(g, [5.5, 5.5, 9], [0, 0, -1]);
    expect(hit).not.toBeNull();
    expect(hit!.cell).toEqual([5, 5, 0]);
    expect(hit!.normal).toEqual([0, 0, 1]); // entered through the top face
  });

  it("hits the +x face of a voxel approached along −x", () => {
    const g = new VoxelGrid([10, 10, 10]);
    g.set(2, 4, 4, true);
    const hit = rayVoxelHit(g, [9, 4.5, 4.5], [-1, 0, 0]);
    expect(hit!.cell).toEqual([2, 4, 4]);
    expect(hit!.normal).toEqual([1, 0, 0]);
  });

  it("returns null when the ray misses every voxel", () => {
    const g = new VoxelGrid([10, 10, 10]);
    g.set(5, 5, 0, true);
    expect(rayVoxelHit(g, [0.5, 0.5, 9], [0, 0, -1])).toBeNull(); // different column
  });

  it("the hit cell + normal give the adjacent cell to add a voxel onto", () => {
    const g = new VoxelGrid([10, 10, 10]);
    g.set(5, 5, 0, true);
    const hit = rayVoxelHit(g, [5.5, 5.5, 9], [0, 0, -1])!;
    const add: [number, number, number] = [
      hit.cell[0] + hit.normal[0],
      hit.cell[1] + hit.normal[1],
      hit.cell[2] + hit.normal[2],
    ];
    expect(add).toEqual([5, 5, 1]); // stack a voxel on top
  });
});

describe("rayWorkPlaneCell", () => {
  it("maps a ray onto the ground plane's grid cell", () => {
    const g = new VoxelGrid([8, 8, 8], 1, [0, 0, 0]);
    const cell = rayWorkPlaneCell(g, [1.5, 1.5, 5], [0, 0, -1], { point: [0, 0, 0], normal: [0, 0, 1] });
    expect(cell).toEqual([1, 1, 0]);
  });

  it("returns null for a ray parallel to the plane or pointing away", () => {
    const g = new VoxelGrid([8, 8, 8]);
    expect(rayWorkPlaneCell(g, [1, 1, 5], [1, 0, 0], { point: [0, 0, 0], normal: [0, 0, 1] })).toBeNull();
    expect(rayWorkPlaneCell(g, [1, 1, 5], [0, 0, 1], { point: [0, 0, 0], normal: [0, 0, 1] })).toBeNull();
  });
});
