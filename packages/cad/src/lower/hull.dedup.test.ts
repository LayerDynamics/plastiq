// convexHull point-dedup — equivalence of the spatial-hash dedup with the old
// O(n²) all-pairs scan (Review: hull.ts hot path), plus a REAL-WASM fixture:
// the hull of a real box tessellation must come out with exactly the 8 corners,
// unchanged by the dedup rewrite.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { Vec3 } from "../math/index.js";
import { convexHull } from "./hull.js";

const EPS = 1e-9; // must match hull.ts

/** The PREVIOUS dedup, verbatim semantics: keep p unless some already-kept q is
 * within EPS of it on every axis (first-seen wins). The reference the new
 * spatial-hash dedup must be equivalent to. */
function referenceDedup(input: readonly Vec3[]): Vec3[] {
  const pts: Vec3[] = [];
  for (const p of input) {
    if (
      !pts.some(
        (q) =>
          Math.abs(q[0] - p[0]) < EPS && Math.abs(q[1] - p[1]) < EPS && Math.abs(q[2] - p[2]) < EPS,
      )
    ) {
      pts.push([p[0], p[1], p[2]]);
    }
  }
  return pts;
}

/** Deterministic LCG so the "random" cloud is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** A cloud with heavy sub-EPS duplication: cube corners + interior points, each
 * repeated with jitter far below the dedup tolerance. */
function jitteredCubeCloud(): Vec3[] {
  const rand = lcg(42);
  const corners: Vec3[] = [];
  for (const x of [0, 0.02]) {
    for (const y of [0, 0.02]) {
      for (const z of [0, 0.02]) corners.push([x, y, z]);
    }
  }
  const cloud: Vec3[] = [];
  for (const c of corners) {
    for (let k = 0; k < 7; k++) {
      // Jitter within ±0.4·EPS — always a duplicate of the first-seen corner.
      cloud.push([
        c[0] + (rand() - 0.5) * 0.8 * EPS,
        c[1] + (rand() - 0.5) * 0.8 * EPS,
        c[2] + (rand() - 0.5) * 0.8 * EPS,
      ]);
    }
  }
  // Interior points (never hull vertices), also duplicated.
  for (let k = 0; k < 40; k++) {
    const p: Vec3 = [0.002 + rand() * 0.016, 0.002 + rand() * 0.016, 0.002 + rand() * 0.016];
    cloud.push(p, [p[0] + 0.3 * EPS, p[1] - 0.3 * EPS, p[2] + 0.3 * EPS]);
  }
  return cloud;
}

describe("spatial-hash dedup ≡ the previous all-pairs dedup", () => {
  it("keeps sub-EPS duplicates collapsed: a jittered cube cloud hulls to exactly 8 corners", () => {
    const hull = convexHull(jitteredCubeCloud());
    expect(hull.vertices).toHaveLength(8);
    // Every hull vertex is (a sub-EPS jitter of) a true cube corner.
    for (const v of hull.vertices) {
      for (const c of v) {
        expect(Math.min(Math.abs(c - 0), Math.abs(c - 0.02))).toBeLessThan(EPS);
      }
    }
  });

  it("produces the SAME hull as hulling the reference-deduped points (synthetic cloud)", () => {
    const cloud = jitteredCubeCloud();
    // convexHull(referenceDedup(cloud)) sees exactly the point set the OLD code
    // hulled; equality of the results proves the new dedup kept the same set in
    // the same order.
    expect(convexHull(cloud)).toEqual(convexHull(referenceDedup(cloud)));
  });

  it("treats the exact-EPS boundary identically to the reference (strict <)", () => {
    const cloud: Vec3[] = [
      [0, 0, 0],
      [EPS, 0, 0], // exactly EPS apart on x → NOT a duplicate (predicate is strict <)
      [0.999 * EPS, 0, 0], // within EPS of the first → duplicate, dropped
      [0.01, 0, 0],
      [0, 0.01, 0],
      [0, 0, 0.01],
    ];
    // referenceDedup(cloud) is exactly the point set the OLD code hulled; the
    // boundary points sit in ADJACENT hash cells, so this exercises the 27-cell
    // neighbourhood probe at the tolerance edge.
    expect(convexHull(cloud)).toEqual(convexHull(referenceDedup(cloud)));
  });

  it("first-seen wins: a sub-EPS duplicate resolves to the FIRST point seen, as before", () => {
    const jittered: Vec3 = [0.4 * EPS, 0, 0];
    const cloud: Vec3[] = [
      jittered, // listed before the exact corner — its coordinates must win
      [0, 0, 0],
      [0.01, 0, 0],
      [0, 0.01, 0],
      [0, 0, 0.01],
    ];
    const hull = convexHull(cloud);
    expect(hull).toEqual(convexHull(referenceDedup(cloud)));
    expect(hull.vertices).toContainEqual(jittered);
    expect(hull.vertices).not.toContainEqual([0, 0, 0]);
  });

  it("still rejects degenerate inputs after full dedup", () => {
    // 40 sub-EPS copies of one point collapse to a single kept point.
    const one: Vec3[] = Array.from({ length: 40 }, (_, i) => [i * EPS * 0.01, 0, 0]);
    expect(() => convexHull(one)).toThrow(/non-coplanar|coincident/);
  });
});

describe("real-wasm fixture: the hull of a box tessellation is unchanged", () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await initOcct();
  }, 120_000);

  it("a tessellated box (corners duplicated per face) hulls to its 8 corners", () => {
    const dx = mm(20);
    const dy = mm(30);
    const dz = mm(40);
    const box = makeBox(oc, dx, dy, dz);
    const mesh = tessellateTagged(oc, box);
    const points: Vec3[] = [];
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      points.push([mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!]);
    }

    const hull = convexHull(points);
    expect(hull.vertices).toHaveLength(8);
    for (const [x, y, z] of hull.vertices) {
      expect(Math.min(Math.abs(x), Math.abs(x - dx))).toBeLessThan(1e-9);
      expect(Math.min(Math.abs(y), Math.abs(y - dy))).toBeLessThan(1e-9);
      expect(Math.min(Math.abs(z), Math.abs(z - dz))).toBeLessThan(1e-9);
    }
    // Same hull vertices/faces before/after the dedup rewrite: hulling the
    // reference-deduped set (what the old code saw) gives the identical result.
    expect(hull).toEqual(convexHull(referenceDedup(points)));
    box.delete();
  });
});
