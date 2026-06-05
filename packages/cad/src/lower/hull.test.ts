// Convex hull correctness — pure geometry, no wasm.

import { describe, expect, it } from "vitest";

import { convexHull } from "./hull.js";
import type { Vec3 } from "../math/index.js";
import { cross, dot, sub } from "../math/index.js";

const CUBE: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/** Volume of a triangulated hull via the divergence theorem (normals re-derived). */
function hullVolume(verts: Vec3[], faces: [number, number, number][]): number {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of verts) {
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  const c: Vec3 = [cx / verts.length, cy / verts.length, cz / verts.length];
  let v = 0;
  for (const [a, b, d] of faces) {
    const va = verts[a]!;
    let n = cross(sub(verts[b]!, va), sub(verts[d]!, va));
    if (dot(n, sub(va, c)) < 0) n = [-n[0], -n[1], -n[2]];
    v += dot(va, n) / 6;
  }
  return v;
}

describe("convexHull", () => {
  it("hulls a cube: 8 vertices, 12 triangular faces (Euler F = 2V−4), unit volume", () => {
    const h = convexHull(CUBE);
    expect(h.vertices).toHaveLength(8);
    expect(h.faces).toHaveLength(2 * 8 - 4); // 12 triangles
    for (const f of h.faces) expect(f).toHaveLength(3);
    expect(hullVolume(h.vertices, h.faces)).toBeCloseTo(1, 9);
  });

  it("discards interior points", () => {
    const h = convexHull([...CUBE, [0.5, 0.5, 0.5], [0.3, 0.3, 0.3]]);
    expect(h.vertices).toHaveLength(8); // the two interior points are dropped
    expect(h.faces).toHaveLength(12);
  });

  it("dedups coincident (per-face duplicated) vertices", () => {
    // Each cube corner duplicated 3× (as the tessellation would).
    const dup = CUBE.flatMap((p) => [p, [...p] as Vec3, [...p] as Vec3]);
    const h = convexHull(dup);
    expect(h.vertices).toHaveLength(8);
    expect(h.faces).toHaveLength(12);
  });

  it("hulls a tetrahedron: 4 vertices, 4 faces", () => {
    const tet: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const h = convexHull(tet);
    expect(h.vertices).toHaveLength(4);
    expect(h.faces).toHaveLength(4);
    expect(hullVolume(h.vertices, h.faces)).toBeCloseTo(1 / 6, 9);
  });

  it("rejects degenerate (coplanar) input", () => {
    expect(() =>
      convexHull([
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ]),
    ).toThrow(/coplanar/);
  });
});
