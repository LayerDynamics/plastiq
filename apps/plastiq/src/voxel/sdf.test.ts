// §16 Phase 4 — the SDF grid: sphere → MC (watertight, plausible counts, outward normals),
// occupancy migration, the doc bridges, and the mesh→SDF→MC box round-trip (CAD→sculpt bake).

import { describe, expect, it } from "vitest";

import { SdfGrid, sdfFromDoc, pointTriangleDistance } from "./sdf.js";
import { VoxelGrid } from "./grid.js";
import { gridToDoc } from "./doc.js";

function boundaryEdges(indices: number[]): number {
  const uses = new Map<string, number>();
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const t = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    for (let e = 0; e < 3; e++) {
      const k = key(t[e]!, t[(e + 1) % 3]!);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  let b = 0;
  for (const c of uses.values()) if (c % 2 === 1) b++;
  return b;
}

/** Axis-aligned unit box mesh centred at the origin, side `s`. 12 triangles, outward wound. */
function boxMesh(s: number): { positions: Float32Array; indices: Uint32Array } {
  const h = s / 2;
  const v = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  const positions = new Float32Array(v.flat());
  // faces (CCW outward)
  const q = (a: number, b: number, c: number, d: number): number[] => [a, b, c, a, c, d];
  const indices = new Uint32Array([
    ...q(0, 3, 2, 1), // -z
    ...q(4, 5, 6, 7), // +z
    ...q(0, 1, 5, 4), // -y
    ...q(2, 3, 7, 6), // +y
    ...q(1, 2, 6, 5), // +x
    ...q(0, 4, 7, 3), // -x
  ]);
  return { positions, indices };
}

describe("SdfGrid.sphere → marching cubes", () => {
  it("produces a watertight manifold sphere with plausible counts and outward normals", () => {
    const g = SdfGrid.sphere([28, 28, 28], 0.01, [-0.14, -0.14, -0.14], [0, 0, 0], 0.1);
    const mesh = g.toMesh();
    const nv = mesh.vertices.length / 3;
    const nt = mesh.indices.length / 3;
    expect(nv).toBeGreaterThan(200);
    expect(nt).toBeGreaterThan(400);
    expect(boundaryEdges(mesh.indices)).toBe(0); // closed
    // outward normals: dot with radial > 0 for the vast majority
    const normals = mesh.normals!;
    let agree = 0;
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      const d = normals[i]! * mesh.vertices[i]! + normals[i + 1]! * mesh.vertices[i + 1]! + normals[i + 2]! * mesh.vertices[i + 2]!;
      if (d > 0) agree++;
    }
    expect(agree / nv).toBeGreaterThan(0.9);
    // vertices track the sphere radius
    let sum = 0;
    for (let i = 0; i < mesh.vertices.length; i += 3) sum += Math.hypot(mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!);
    expect(sum / nv).toBeGreaterThan(0.08);
    expect(sum / nv).toBeLessThan(0.12);
  });
});

describe("SdfGrid.fromOccupancy (schema migration)", () => {
  it("signs a solid block negative inside, positive outside, and meshes it closed", () => {
    const grid = new VoxelGrid([12, 12, 12], 1, [0, 0, 0]);
    grid.addBox([3, 3, 3], [8, 8, 8]);
    const sdf = SdfGrid.fromOccupancy(grid);
    // a deep-interior cell is negative; a far-outside cell is positive (saturated).
    expect(sdf.at(5, 5, 5)).toBeLessThan(0);
    expect(sdf.at(0, 0, 0)).toBeGreaterThan(0);
    const mesh = sdf.toMesh();
    expect(mesh.indices.length / 3).toBeGreaterThan(50);
    expect(boundaryEdges(mesh.indices)).toBe(0);
  });

  it("sdfFromDoc migrates a legacy (v1) doc and preserves the inside count sign", () => {
    const grid = new VoxelGrid([10, 10, 10], 1, [0, 0, 0]);
    grid.addBox([2, 2, 2], [7, 7, 7]);
    const doc = gridToDoc(grid, "legacy"); // no sdf, no version
    expect(doc.sdf).toBeUndefined();
    const sdf = sdfFromDoc(doc);
    // Every occupied cell should be inside (negative) in the migrated field.
    const occupied = sdf.occupiedCells();
    expect(occupied.length).toBeGreaterThan(0);
    for (const i of occupied) expect(sdf.field[i]!).toBeLessThan(0);
  });
});

describe("SdfGrid doc round-trip", () => {
  it("toDoc writes a v2 doc with a synced occupancy shadow; sdfFromDoc restores the field", () => {
    const g = SdfGrid.sphere([16, 16, 16], 0.02, [-0.16, -0.16, -0.16], [0, 0, 0], 0.12);
    const doc = g.toDoc("ball");
    expect(doc.version).toBe(2);
    expect(doc.sdf).toBeDefined();
    expect(doc.sdf!.field.length).toBe(16 * 16 * 16);
    expect(doc.cells.length).toBe(g.occupiedCells().length);
    const back = sdfFromDoc(doc);
    expect(Array.from(back.field)).toEqual(Array.from(g.field));
  });
});

describe("SdfGrid.fromMesh (CAD→sculpt bake) → MC box round-trip", () => {
  it("bakes a box mesh into an SDF whose MC surface approximates the box", () => {
    const box = boxMesh(0.2); // 200 mm cube at the origin
    const sdf = SdfGrid.fromMesh(box.positions, box.indices, { voxelSize: 0.02, margin: 2 });
    // inside the box → negative; well outside → positive.
    expect(sdf.sampleWorld([0, 0, 0])).toBeLessThan(0);
    expect(sdf.sampleWorld([0.5, 0.5, 0.5])).toBeGreaterThan(0);
    const mesh = sdf.toMesh();
    expect(mesh.indices.length / 3).toBeGreaterThan(50);
    expect(boundaryEdges(mesh.indices)).toBe(0);
    // Bounding box of the reconstructed surface ≈ the original box (within ~1.5 voxels).
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, mesh.vertices[i + a]!);
        max[a] = Math.max(max[a]!, mesh.vertices[i + a]!);
      }
    }
    for (let a = 0; a < 3; a++) {
      expect(Math.abs(min[a]! - -0.1)).toBeLessThan(0.03);
      expect(Math.abs(max[a]! - 0.1)).toBeLessThan(0.03);
    }
  });
});

describe("pointTriangleDistance", () => {
  it("computes distance to a triangle in the z=0 plane", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];
    const c: [number, number, number] = [0, 1, 0];
    // A point directly above the interior.
    expect(pointTriangleDistance([0.25, 0.25, 2], a, b, c)).toBeCloseTo(2, 6);
    // A point off a vertex.
    expect(pointTriangleDistance([-1, -1, 0], a, b, c)).toBeCloseTo(Math.SQRT2, 6);
  });
});
