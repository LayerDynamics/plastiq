// tessellate — the grid triangulation is watertight in (u,v); a planar control
// net yields coplanar vertices with mutually-parallel normals.

import { describe, expect, it } from "vitest";

import { tessellate, type NurbsSurface, type Vec3 } from "./index.js";

/** A degU = degV = 2 patch whose control points all lie on the plane
 * z = 0.3x + 0.5y, so the whole surface is that plane. */
function planarPatch(): NurbsSurface {
  const net: Vec3[][] = [];
  for (let i = 0; i < 3; i++) {
    const row: Vec3[] = [];
    for (let j = 0; j < 3; j++) row.push([i, j, 0.3 * i + 0.5 * j]);
    net.push(row);
  }
  return {
    degU: 2,
    degV: 2,
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 0, 1, 1, 1],
    controlNet: net,
  };
}

describe("tessellate — planar net", () => {
  const mesh = tessellate(planarPatch(), { resU: 6, resV: 5 });
  const vertexCount = (6 + 1) * (5 + 1);

  it("produces the expected vertex and index counts", () => {
    expect(mesh.positions.length).toBe(vertexCount * 3);
    expect(mesh.normals.length).toBe(vertexCount * 3);
    expect(mesh.indices.length).toBe(6 * 5 * 6);
  });

  it("places every vertex on the plane z = 0.3x + 0.5y (coplanar)", () => {
    for (let k = 0; k < mesh.positions.length; k += 3) {
      const x = mesh.positions[k]!;
      const y = mesh.positions[k + 1]!;
      const z = mesh.positions[k + 2]!;
      // positions/normals are Float32Array (spec-mandated) → ~1e-7 precision.
      expect(z).toBeCloseTo(0.3 * x + 0.5 * y, 5);
    }
  });

  it("gives every vertex the same unit normal (all parallel)", () => {
    // Plane normal ∝ (-0.3, -0.5, 1).
    const n0: Vec3 = [
      mesh.normals[0]!,
      mesh.normals[1]!,
      mesh.normals[2]!,
    ];
    // Float32Array storage → assert to float32 precision (~1e-6), not double.
    expect(Math.hypot(n0[0], n0[1], n0[2])).toBeCloseTo(1, 5);
    const expected = 1 / Math.hypot(-0.3, -0.5, 1);
    expect(Math.abs(n0[2])).toBeCloseTo(expected, 5);
    for (let k = 0; k < mesh.normals.length; k += 3) {
      const n: Vec3 = [mesh.normals[k]!, mesh.normals[k + 1]!, mesh.normals[k + 2]!];
      const dot = n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2];
      expect(Math.abs(dot)).toBeCloseTo(1, 5); // parallel to n0
    }
  });

  it("references only in-range vertices", () => {
    for (let k = 0; k < mesh.indices.length; k++) {
      const idx = mesh.indices[k]!;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertexCount);
    }
  });

  it("is watertight: interior edges shared by exactly two triangles", () => {
    const resU = 6;
    const resV = 5;
    const edgeCount = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let e = 0; e < 3; e++) {
        const a = tri[e]!;
        const b = tri[(e + 1) % 3]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    let boundary = 0;
    for (const count of edgeCount.values()) {
      expect(count).toBeLessThanOrEqual(2); // no non-manifold edges
      if (count === 1) boundary++;
    }
    // A resU×resV quad grid has exactly 2*(resU+resV) boundary edges.
    expect(boundary).toBe(2 * (resU + resV));
  });
});

describe("tessellate — curved net still watertight", () => {
  it("has no non-manifold edges on a Bézier saddle", () => {
    const net: Vec3[][] = [];
    for (let i = 0; i < 3; i++) {
      const row: Vec3[] = [];
      for (let j = 0; j < 3; j++) row.push([i, j, (i - 1) * (j - 1)]);
      net.push(row);
    }
    const s: NurbsSurface = {
      degU: 2,
      degV: 2,
      knotsU: [0, 0, 0, 1, 1, 1],
      knotsV: [0, 0, 0, 1, 1, 1],
      controlNet: net,
    };
    const mesh = tessellate(s, { resU: 8, resV: 8 });
    const edgeCount = new Map<string, number>();
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      for (let e = 0; e < 3; e++) {
        const a = tri[e]!;
        const b = tri[(e + 1) % 3]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    for (const count of edgeCount.values()) expect(count).toBeLessThanOrEqual(2);
    // All normals are unit length.
    for (let k = 0; k < mesh.normals.length; k += 3) {
      const len = Math.hypot(
        mesh.normals[k]!,
        mesh.normals[k + 1]!,
        mesh.normals[k + 2]!,
      );
      expect(len).toBeCloseTo(1, 5); // Float32Array precision
    }
  });
});
