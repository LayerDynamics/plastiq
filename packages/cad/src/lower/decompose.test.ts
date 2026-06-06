// Convex decomposition: a concave part splits into several convex pieces; a
// convex part stays a single hull via the concavity gate (no V-HACD cost).

import { beforeAll, describe, expect, it } from "vitest";

import { collidersFor, initDecomposer, meshVolume } from "./decompose.js";
import { convexHull } from "./hull.js";

type P3 = [number, number, number];

/**
 * Is point `p` strictly inside the convex polyhedron (points + triangle faces)?
 * Winding-independent: `p` is inside iff, for every face, it lies on the same
 * side of the face plane as the polyhedron's centroid.
 */
function insideConvex(points: readonly number[], faces: readonly number[][], p: P3): boolean {
  const n = points.length / 3;
  let gx = 0,
    gy = 0,
    gz = 0;
  for (let i = 0; i < n; i++) {
    gx += points[3 * i]!;
    gy += points[3 * i + 1]!;
    gz += points[3 * i + 2]!;
  }
  const g: P3 = [gx / n, gy / n, gz / n];
  const at = (i: number): P3 => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!];
  const EPS = 1e-9;
  for (const f of faces) {
    const a = at(f[0]!);
    const b = at(f[1]!);
    const c = at(f[2]!);
    // Face plane normal n = (b−a)×(c−a).
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const sp = nx * (p[0] - a[0]) + ny * (p[1] - a[1]) + nz * (p[2] - a[2]);
    const sg = nx * (g[0] - a[0]) + ny * (g[1] - a[1]) + nz * (g[2] - a[2]);
    // p on the opposite side of this face from the centroid ⇒ outside.
    if (sp * sg < -EPS) return false;
  }
  return true;
}

beforeAll(async () => {
  await initDecomposer();
}, 120_000);

interface Mesh {
  positions: number[];
  indices: number[];
  volume: number;
}

/** A closed axis-aligned cube of half-extent `h` (convex). */
function cubeMesh(h: number): Mesh {
  const positions = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, // 0..3 bottom (z=-h)
    -h, -h, h, h, -h, h, h, h, h, -h, h, h, //     4..7 top    (z=+h)
  ];
  const indices = [
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    3, 7, 6, 3, 6, 2, // +y
    0, 4, 7, 0, 7, 3, // -x
    1, 2, 6, 1, 6, 5, // +x
  ];
  return { positions, indices, volume: (2 * h) ** 3 };
}

/**
 * A closed L-shaped extruded prism (genuinely concave): footprint is an L in XY
 * (area 3), extruded in Z over [0,1] → volume 3. Its convex hull fills the notch
 * (hull volume 3.5), so concavity = (3.5−3)/3.5 ≈ 14% — well past the gate.
 */
function lPrismMesh(): Mesh {
  const foot: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [1, 1],
    [1, 2],
    [0, 2],
  ];
  const positions: number[] = [];
  const idx = new Map<string, number>();
  const vid = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let r = idx.get(key);
    if (r === undefined) {
      r = positions.length / 3;
      idx.set(key, r);
      positions.push(x, y, z);
    }
    return r;
  };
  const indices: number[] = [];
  const tri = (a: number, b: number, c: number): void => {
    indices.push(a, b, c);
  };
  // Caps: fan from foot[0]=(0,0), which sees the whole L (star point). Wind the
  // bottom cap downward and the top cap upward.
  for (const z of [0, 1]) {
    for (let i = 1; i < foot.length - 1; i++) {
      const a = vid(foot[0]![0], foot[0]![1], z);
      const b = vid(foot[i]![0], foot[i]![1], z);
      const c = vid(foot[i + 1]![0], foot[i + 1]![1], z);
      if (z === 0) tri(a, b, c);
      else tri(a, c, b);
    }
  }
  // Side walls.
  for (let i = 0; i < foot.length; i++) {
    const j = (i + 1) % foot.length;
    const a = vid(foot[i]![0], foot[i]![1], 0);
    const b = vid(foot[j]![0], foot[j]![1], 0);
    const c = vid(foot[j]![0], foot[j]![1], 1);
    const d = vid(foot[i]![0], foot[i]![1], 1);
    tri(a, b, c);
    tri(a, c, d);
  }
  return { positions, indices, volume: 3 };
}

describe("collidersFor — convex decomposition", () => {
  it("keeps a convex part as a SINGLE hull (concavity gate, no decomposition)", () => {
    const m = cubeMesh(0.5);
    const colliders = collidersFor(m.positions, m.indices, m.volume);
    expect(colliders).toHaveLength(1);
    // The single hull is the cube itself (unit volume).
    expect(meshVolume(colliders[0]!.points, colliders[0]!.faces)).toBeCloseTo(1, 6);
  });

  it("decomposes a concave L-prism into MULTIPLE convex pieces", () => {
    const m = lPrismMesh();
    const colliders = collidersFor(m.positions, m.indices, m.volume);
    // The L cannot be one convex shape — it must split into ≥ 2 convex pieces.
    expect(colliders.length).toBeGreaterThanOrEqual(2);
    // Each piece is a real convex hull (≥ 4 vertices, ≥ 4 faces).
    for (const c of colliders) {
      expect(c.points.length / 3).toBeGreaterThanOrEqual(4);
      expect(c.faces.length).toBeGreaterThanOrEqual(4);
    }
    // The pieces together track the real solid (volume 3), not the bulged hull
    // (3.5) — V-HACD approximates, so allow a generous band.
    const total = colliders.reduce((s, c) => s + meshVolume(c.points, c.faces), 0);
    expect(total).toBeGreaterThan(2.4);
    expect(total).toBeLessThan(3.6);
  });

  it("leaves the concavity OPEN: a point in the notch is inside the hull but outside every piece", () => {
    const m = lPrismMesh();
    const cloud: P3[] = [];
    for (let k = 0; k < m.positions.length; k += 3) {
      cloud.push([m.positions[k]!, m.positions[k + 1]!, m.positions[k + 2]!]);
    }
    // (1.3, 1.3, 0.5) sits in the L's notch — outside the real solid, but inside
    // the solid's convex hull (x+y = 2.6 < the hull's 3.0 cut), 0.3 deep into the
    // pocket. This is the point a single bounding hull would wrongly fill.
    const inNotch: P3 = [1.3, 1.3, 0.5];

    const whole = convexHull(cloud);
    const wholePoints = whole.vertices.flat();
    // The convex hull DOES contain the notch point (this is exactly the defect a
    // single-hull collider has).
    expect(insideConvex(wholePoints, whole.faces, inNotch)).toBe(true);

    // The decomposition must NOT: the point lies outside every convex piece, so
    // the compound collider leaves the pocket empty. A regression that re-bulged
    // the concavity (or fell back to one hull) would put the point inside a piece
    // and fail here — which the rest-height and volume assertions cannot catch.
    const colliders = collidersFor(m.positions, m.indices, m.volume);
    for (const c of colliders) {
      expect(insideConvex(c.points, c.faces, inNotch)).toBe(false);
    }
  });

  it("respects a tighter concavity tolerance only triggering on real concavity", () => {
    // The cube is convex → still one hull even at a strict tolerance.
    const cube = cubeMesh(0.5);
    expect(collidersFor(cube.positions, cube.indices, cube.volume, { concavityTolerance: 0.001 })).toHaveLength(1);
  });
});
