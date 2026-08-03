import { describe, expect, it } from "vitest";
import type { MeshBody } from "./meshBody.js";
import {
  cloneMeshSelection,
  completeMeshFacePicks,
  decodeMeshPick,
  encodeMeshPick,
  meshFaces,
  meshSegments,
  transformMeshSelection,
  translateMeshSelection,
  computeMeshVertexNormals,
  displaceMeshVertices,
  smoothMeshCotangent,
  isotropicRemesh,
  quadricDecimate,
  bakeMeshBodyToSdfDoc,
} from "./editMesh.js";
import { voxelDocToMesh } from "../voxel/doc.js";

function body(): MeshBody {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe("mesh edit helpers", () => {
  it("encodes mesh picks without collisions across bodies", () => {
    const a = encodeMeshPick(0, 7);
    const b = encodeMeshPick(2, 7);
    expect(a).not.toBe(b);
    expect(decodeMeshPick(b)).toEqual({ body: 2, local: 7 });
  });

  it("moves only the selected vertex", () => {
    const next = translateMeshSelection([body()], [{ kind: "vertex", id: encodeMeshPick(0, 1) }], [0, 0, 2]);
    expect(Array.from(next[0]!.positions)).toEqual([0, 0, 0, 1, 0, 2, 0, 1, 0]);
  });

  it("moves both endpoints of a selected segment", () => {
    const next = translateMeshSelection([body()], [{ kind: "edge", id: encodeMeshPick(0, 0) }], [0, 0, 2]);
    expect(Array.from(next[0]!.positions)).toEqual([0, 0, 2, 1, 0, 2, 0, 1, 0]);
  });

  it("maps triangle faces to their boundary vertices and segments", () => {
    expect(meshFaces(body())).toEqual([{ vertices: [0, 1, 2], edges: [0, 1, 2] }]);
  });

  it("promotes a face only when all boundary vertices and segments are selected", () => {
    const almost = [
      { kind: "vertex", id: encodeMeshPick(0, 0) },
      { kind: "vertex", id: encodeMeshPick(0, 1) },
      { kind: "vertex", id: encodeMeshPick(0, 2) },
      { kind: "edge", id: encodeMeshPick(0, 0) },
      { kind: "edge", id: encodeMeshPick(0, 1) },
    ];
    expect(completeMeshFacePicks([body()], almost)).toEqual([]);
    expect(completeMeshFacePicks([body()], [...almost, { kind: "edge", id: encodeMeshPick(0, 2) }])).toEqual([
      { kind: "face", id: encodeMeshPick(0, 0) },
    ]);
  });

  it("applies a full transform matrix to selected segment endpoints", () => {
    const rotate90AboutOrigin = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const next = transformMeshSelection([body()], [{ kind: "edge", id: encodeMeshPick(0, 1) }], rotate90AboutOrigin);
    expect(Array.from(next[0]!.positions)).toEqual([0, 0, 0, 0, 1, 0, -1, 0, 0]);
  });

  it("clones vertices as independent points and segments as standalone cloned segments", () => {
    const next = cloneMeshSelection(
      [body()],
      [
        { kind: "vertex", id: encodeMeshPick(0, 2) },
        { kind: "edge", id: encodeMeshPick(0, 0) },
      ],
      [0, 0, 1],
    );
    expect(next[0]!.positions.length / 3).toBe(6);
    expect(next[0]!.segments).toBeDefined();
    expect(meshSegments(next[0]!).length).toBe(4);
    expect(Array.from(next[0]!.positions.slice(9))).toEqual([0, 1, 1, 0, 0, 1, 1, 0, 1]);
  });

  it("clones a selected mesh body as independent indexed triangles", () => {
    const next = cloneMeshSelection([body()], [{ kind: "body", id: encodeMeshPick(0, 0) }], [0, 0, 1]);
    expect(next[0]!.positions.length / 3).toBe(6);
    expect(Array.from(next[0]!.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(next[0]!.positions.slice(9))).toEqual([0, 0, 1, 1, 0, 1, 0, 1, 1]);
  });
});

// §16 Phase 4 — mesh-lane sculpt operations.

/** A flat 3×3 vertex grid in z=0 (2×2 quads, 8 triangles), wound CCW so normals face +Z. */
function planeGrid(): MeshBody {
  const positions: number[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) positions.push(i - 1, j - 1, 0);
  const idx = (i: number, j: number): number => j * 3 + i;
  const indices: number[] = [];
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      indices.push(idx(i, j), idx(i + 1, j), idx(i + 1, j + 1));
      indices.push(idx(i, j), idx(i + 1, j + 1), idx(i, j + 1));
    }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** A regular tetrahedron (closed, 4 triangles), outward wound. */
function tetra(): MeshBody {
  const positions = new Float32Array([1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]);
  return { positions, indices };
}

function boxMesh(s: number): MeshBody {
  const h = s / 2;
  const v = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
  const q = (a: number, b: number, c: number, d: number): number[] => [a, b, c, a, c, d];
  return {
    positions: new Float32Array(v.flat()),
    indices: new Uint32Array([
      ...q(0, 3, 2, 1), ...q(4, 5, 6, 7), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(0, 4, 7, 3),
    ]),
  };
}

function boundaryEdges(indices: Uint32Array | number[]): number {
  const uses = new Map<string, number>();
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let i = 0; i + 2 < indices.length; i += 3)
    for (let e = 0; e < 3; e++) {
      const a = indices[i + e]!;
      const b = indices[i + ((e + 1) % 3)]!;
      const k = key(a, b);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  let b = 0;
  for (const c of uses.values()) if (c % 2 === 1) b++;
  return b;
}

function maxEdgeLength(body: MeshBody): number {
  let m = 0;
  const p = body.positions;
  for (let i = 0; i + 2 < body.indices.length; i += 3)
    for (let e = 0; e < 3; e++) {
      const a = body.indices[i + e]! * 3;
      const c = body.indices[i + ((e + 1) % 3)]! * 3;
      m = Math.max(m, Math.hypot(p[a]! - p[c]!, p[a + 1]! - p[c + 1]!, p[a + 2]! - p[c + 2]!));
    }
  return m;
}

describe("computeMeshVertexNormals", () => {
  it("gives +Z normals for a CCW plane grid", () => {
    const n = computeMeshVertexNormals(planeGrid());
    for (let i = 0; i < n.length; i += 3) expect(n[i + 2]).toBeCloseTo(1, 5);
  });
});

describe("displaceMeshVertices (mesh brush)", () => {
  it("moves only vertices within the radius, along the normal", () => {
    const before = planeGrid();
    const after = displaceMeshVertices(before, { center: [0, 0, 0], radius: 0.9, strength: 0.5, falloff: "constant" });
    // The centre vertex (index 4 = (0,0,0)) is within radius → pushed +Z by strength.
    expect(after.positions[4 * 3 + 2]).toBeCloseTo(0.5, 5);
    // A corner vertex at distance √2 > 0.9 is untouched.
    expect(after.positions[0 * 3 + 2]).toBe(0);
  });
});

describe("smoothMeshCotangent (Laplacian fairing)", () => {
  it("reduces a spiked vertex toward its neighbours", () => {
    const g = planeGrid();
    g.positions[4 * 3 + 2] = 1; // spike the centre up in Z
    const smoothed = smoothMeshCotangent(g, { iterations: 3, lambda: 0.5 });
    expect(smoothed.positions[4 * 3 + 2]).toBeLessThan(1);
    expect(smoothed.positions[4 * 3 + 2]).toBeGreaterThanOrEqual(0);
  });
});

describe("isotropicRemesh", () => {
  it("refines a tetra toward a smaller edge length, staying closed", () => {
    const t = tetra();
    const target = maxEdgeLength(t) / 4;
    const remeshed = isotropicRemesh(t, { targetEdgeLength: target, iterations: 3 });
    expect(remeshed.indices.length / 3).toBeGreaterThan(t.indices.length / 3);
    expect(maxEdgeLength(remeshed)).toBeLessThan(maxEdgeLength(t));
    expect(boundaryEdges(remeshed.indices)).toBe(0); // still watertight
  });
});

/** Midpoint-subdivide every triangle 1→4 (shared edge midpoints); exact on flat faces. */
function subdivide(body: MeshBody): MeshBody {
  const pos = Array.from(body.positions);
  const tris: number[] = [];
  const mids = new Map<number, number>();
  const midOf = (a: number, b: number): number => {
    const key = a < b ? a * 0x100000000 + b : b * 0x100000000 + a;
    const cached = mids.get(key);
    if (cached !== undefined) return cached;
    const id = pos.length / 3;
    pos.push((pos[a * 3]! + pos[b * 3]!) / 2, (pos[a * 3 + 1]! + pos[b * 3 + 1]!) / 2, (pos[a * 3 + 2]! + pos[b * 3 + 2]!) / 2);
    mids.set(key, id);
    return id;
  };
  for (let i = 0; i + 2 < body.indices.length; i += 3) {
    const a = body.indices[i]!;
    const b = body.indices[i + 1]!;
    const c = body.indices[i + 2]!;
    const ab = midOf(a, b);
    const bc = midOf(b, c);
    const ca = midOf(c, a);
    tris.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(tris) };
}

describe("quadricDecimate", () => {
  it("reduces triangle count while keeping the surface within a bounded error", () => {
    // A densely subdivided box (flat faces, sharp box edges/corners preserved by QEM).
    let dense = boxMesh(0.2);
    for (let k = 0; k < 3; k++) dense = subdivide(dense); // 12 → 768 triangles
    const startTris = dense.indices.length / 3;
    const decimated = quadricDecimate(dense, { targetRatio: 0.3 });
    const endTris = decimated.indices.length / 3;
    expect(endTris).toBeLessThan(startTris);
    expect(endTris).toBeGreaterThan(3);
    expect(boundaryEdges(decimated.indices)).toBe(0); // stays closed
    // Bounded error: the decimated bounding box still tracks the original box (±0.1).
    const bbox = (b: MeshBody): [number[], number[]] => {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < b.positions.length; i += 3)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, b.positions[i + a]!);
          max[a] = Math.max(max[a]!, b.positions[i + a]!);
        }
      return [min, max];
    };
    const [dmin, dmax] = bbox(decimated);
    for (let a = 0; a < 3; a++) {
      expect(Math.abs(dmin[a]! - -0.1)).toBeLessThan(0.02);
      expect(Math.abs(dmax[a]! - 0.1)).toBeLessThan(0.02);
    }
  });
});

describe("bakeMeshBodyToSdfDoc (CAD→sculpt bridge)", () => {
  it("bakes a box into a v2 voxel doc whose MC surface tracks the box", () => {
    const doc = bakeMeshBodyToSdfDoc(boxMesh(0.2), { voxelSize: 0.02, name: "baked" });
    expect(doc.kind).toBe("voxel");
    expect(doc.version).toBe(2);
    expect(doc.sdf).toBeDefined();
    expect(doc.cells.length).toBeGreaterThan(0);
    const mesh = voxelDocToMesh(doc); // routes to marching cubes (v2 doc)
    expect(mesh.indices.length / 3).toBeGreaterThan(20);
    expect(boundaryEdges(mesh.indices)).toBe(0);
  });
});
