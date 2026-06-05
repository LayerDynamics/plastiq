import { describe, expect, it } from "vitest";
import type { Vec3 } from "../math/index.js";
import { convexHull, type Hull } from "./hull.js";

/** Signed volume of a closed triangle mesh (outward winding ⇒ positive). */
function hullVolume(h: Hull): number {
  let v = 0;
  for (const [a, b, c] of h.faces) {
    const p = h.vertices[a]!;
    const q = h.vertices[b]!;
    const r = h.vertices[c]!;
    v +=
      p[0] * (q[1] * r[2] - q[2] * r[1]) -
      p[1] * (q[0] * r[2] - q[2] * r[0]) +
      p[2] * (q[0] * r[1] - q[1] * r[0]);
  }
  return v / 6;
}

const CUBE_CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

describe("convexHull (FR-26 lowering support)", () => {
  it("hulls a cube's corners → 8 vertices, 12 outward triangles, volume 1", () => {
    const h = convexHull(CUBE_CORNERS);
    expect(h.vertices).toHaveLength(8);
    expect(h.faces).toHaveLength(12); // 2 triangles per cube face
    expect(Math.abs(hullVolume(h) - 1)).toBeLessThan(1e-12);
  });

  it("interior and surface points do not change the hull", () => {
    const pts: Vec3[] = [
      ...CUBE_CORNERS,
      [0.5, 0.5, 0.5], // dead center
      [0.5, 0.5, 0], // face center
      [0.25, 0.75, 0.1], // arbitrary interior
    ];
    const h = convexHull(pts);
    expect(h.vertices).toHaveLength(8); // interior points dropped
    expect(Math.abs(hullVolume(h) - 1)).toBeLessThan(1e-12);
  });

  it("every face is wound outward (all hull points on the negative side)", () => {
    const h = convexHull(CUBE_CORNERS);
    for (const [a, b, c] of h.faces) {
      const pa = h.vertices[a]!;
      const pb = h.vertices[b]!;
      const pc = h.vertices[c]!;
      // outward normal
      const nx = (pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]);
      const ny = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]);
      const nz = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      for (const v of h.vertices) {
        const side = nx * (v[0] - pa[0]) + ny * (v[1] - pa[1]) + nz * (v[2] - pa[2]);
        expect(side).toBeLessThan(1e-9); // no vertex strictly outside any face
      }
    }
  });

  it("hulls a tetrahedron → 4 vertices, 4 faces", () => {
    const tetra: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const h = convexHull(tetra);
    expect(h.vertices).toHaveLength(4);
    expect(h.faces).toHaveLength(4);
    expect(Math.abs(hullVolume(h) - 1 / 6)).toBeLessThan(1e-12);
  });

  it("the hull of a non-convex (L-shaped) point set fills the concavity", () => {
    // An L in the z=0/z=1 prism: its convex hull is the bounding triangle prism,
    // strictly larger than the L's own volume.
    const L: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [1, 1, 0],
      [1, 2, 0],
      [0, 2, 0],
      [0, 0, 1],
      [2, 0, 1],
      [2, 1, 1],
      [1, 1, 1],
      [1, 2, 1],
      [0, 2, 1],
    ];
    const h = convexHull(L);
    // The L footprint area is 3; its convex hull footprint (pentagon→triangle
    // fill) is 3.5, so hull volume = 3.5 > the L's 3.
    expect(hullVolume(h)).toBeGreaterThan(3.0);
    expect(hullVolume(h)).toBeLessThan(4.01);
    expect(h.faces.every(([a, b, c]) => a !== b && b !== c && a !== c)).toBe(true);
  });

  it("throws on a degenerate (coplanar) point set", () => {
    const flat: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ];
    expect(() => convexHull(flat)).toThrow(/coplanar|no volume/);
  });
});
