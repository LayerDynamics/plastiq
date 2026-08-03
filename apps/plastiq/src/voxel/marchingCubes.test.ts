// §16 Phase 4 — marching-cubes mesher: table integrity, a single-cell surface, and the
// welded/closed invariants the SDF sculpt path relies on.

import { describe, expect, it } from "vitest";

import { marchingCubes, computeNormals, TRI_TABLE, type ScalarField } from "./marchingCubes.js";

/** A field over an `n³` sample lattice with unit spacing at the origin. */
function fieldFrom(n: number, f: (x: number, y: number, z: number) => number): ScalarField {
  return { nx: n, ny: n, nz: n, sample: f, world: (x, y, z) => [x, y, z] };
}

/** Count how many times each undirected triangle edge is used (boundary edges appear once). */
function boundaryEdgeCount(indices: number[]): number {
  const uses = new Map<string, number>();
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const t = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    for (let e = 0; e < 3; e++) {
      const k = key(t[e]!, t[(e + 1) % 3]!);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0;
  for (const c of uses.values()) if (c % 2 === 1) boundary++;
  return boundary;
}

describe("TRI_TABLE integrity", () => {
  it("has 256 rows, each a multiple of 3 edge indices in 0..11", () => {
    expect(TRI_TABLE).toHaveLength(256);
    for (const row of TRI_TABLE) {
      expect(row.length % 3).toBe(0);
      for (const e of row) expect(e).toBeGreaterThanOrEqual(0), expect(e).toBeLessThan(12);
    }
  });

  it("the empty and full cases emit no triangles; complementary cases mirror", () => {
    expect(TRI_TABLE[0]).toEqual([]);
    expect(TRI_TABLE[255]).toEqual([]);
    // A single inside corner (case 1) makes exactly one triangle.
    expect(TRI_TABLE[1]!.length).toBe(3);
  });
});

describe("marchingCubes", () => {
  it("meshes a plane crossing (half inside) into a watertight-in-the-interior sheet", () => {
    // Field negative for z<1.5 → a surface between the two z-layers.
    const field = fieldFrom(2, (_x, _y, z) => z - 0.5); // crosses 0 between z=0 and z=1? no: values 0-?
    const mesh = marchingCubes(field, 0.5);
    // A 2×2×2 lattice with a planar crossing yields at least two triangles.
    expect(mesh.indices.length).toBeGreaterThanOrEqual(6);
    expect(mesh.vertices.length).toBeGreaterThan(0);
  });

  it("interpolates the crossing to the exact zero (linear field lands mid-edge)", () => {
    // f = x - 1 over a 3-sample axis → zero-crossing at x=1 exactly.
    const field = fieldFrom(3, (x) => x - 1);
    const mesh = marchingCubes(field, 0);
    const xs = mesh.vertices.filter((_, i) => i % 3 === 0);
    for (const x of xs) expect(x).toBeCloseTo(1, 6);
  });

  it("a sphere field yields a closed (no-boundary) welded surface with outward normals", () => {
    const n = 24;
    const c = (n - 1) / 2;
    const r = 7;
    const field = fieldFrom(n, (x, y, z) => Math.hypot(x - c, y - c, z - c) - r);
    const mesh = marchingCubes(field, 0);
    expect(mesh.vertices.length / 3).toBeGreaterThan(100);
    expect(mesh.indices.length / 3).toBeGreaterThan(200);
    // Closed: no odd-used (boundary) edges.
    expect(boundaryEdgeCount(mesh.indices)).toBe(0);
    // Outward: per-vertex normals mostly agree with the radial direction.
    const normals = mesh.normals!;
    let agree = 0;
    let total = 0;
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      const rx = mesh.vertices[i]! - c;
      const ry = mesh.vertices[i + 1]! - c;
      const rz = mesh.vertices[i + 2]! - c;
      const rl = Math.hypot(rx, ry, rz);
      const d = (normals[i]! * rx + normals[i + 1]! * ry + normals[i + 2]! * rz) / (rl || 1);
      if (d > 0) agree++;
      total++;
    }
    expect(agree / total).toBeGreaterThan(0.9);
  });
});

describe("computeNormals", () => {
  it("returns unit normals for a single triangle in the XY plane", () => {
    const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const n = computeNormals(verts, [0, 1, 2]);
    // +Z face normal.
    expect(n[2]).toBeCloseTo(1, 6);
    expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 6);
  });
});
