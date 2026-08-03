import type { MeshBody } from "./meshBody.js";
import { cloneMeshBody } from "./meshBody.js";
import type { VoxelDoc } from "../store/types.js";
import { SdfGrid } from "../voxel/sdf.js";

export const MESH_PICK_STRIDE = 1_000_000;

export interface MeshEntityRef {
  body: number;
  local: number;
}

export interface MeshSegment {
  a: number;
  b: number;
}

export interface MeshFace {
  vertices: [number, number, number];
  edges: [number, number, number];
}

export function encodeMeshPick(body: number, local: number): number {
  return body * MESH_PICK_STRIDE + local;
}

export function decodeMeshPick(id: number): MeshEntityRef {
  return { body: Math.floor(id / MESH_PICK_STRIDE), local: id % MESH_PICK_STRIDE };
}

export function meshVertexCount(body: MeshBody): number {
  return Math.floor(body.positions.length / 3);
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Every selectable line segment in a mesh body: triangle edges plus standalone cloned segments. */
export function meshSegments(body: MeshBody): MeshSegment[] {
  const out: MeshSegment[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number): void => {
    if (a === b) return;
    const key = edgeKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ a, b });
  };
  for (let i = 0; i + 2 < body.indices.length; i += 3) {
    const a = body.indices[i]!;
    const b = body.indices[i + 1]!;
    const c = body.indices[i + 2]!;
    add(a, b);
    add(b, c);
    add(c, a);
  }
  if (body.segments) {
    for (let i = 0; i + 1 < body.segments.length; i += 2) add(body.segments[i]!, body.segments[i + 1]!);
  }
  return out;
}

function segmentIndexByKey(body: MeshBody): Map<string, number> {
  const byKey = new Map<string, number>();
  meshSegments(body).forEach((segment, index) => byKey.set(edgeKey(segment.a, segment.b), index));
  return byKey;
}

/** Triangle faces with the local edge ids needed to decide complete boundary selection. */
export function meshFaces(body: MeshBody): MeshFace[] {
  const byKey = segmentIndexByKey(body);
  const out: MeshFace[] = [];
  for (let i = 0; i + 2 < body.indices.length; i += 3) {
    const a = body.indices[i]!;
    const b = body.indices[i + 1]!;
    const c = body.indices[i + 2]!;
    const ab = byKey.get(edgeKey(a, b));
    const bc = byKey.get(edgeKey(b, c));
    const ca = byKey.get(edgeKey(c, a));
    if (ab == null || bc == null || ca == null) continue;
    out.push({ vertices: [a, b, c], edges: [ab, bc, ca] });
  }
  return out;
}

export function completeMeshFacePicks(
  bodies: readonly MeshBody[],
  picks: readonly { kind: string; id: number }[],
): { kind: "face"; id: number }[] {
  const selectedVertices = new Map<number, Set<number>>();
  const selectedEdges = new Map<number, Set<number>>();
  const add = (map: Map<number, Set<number>>, body: number, local: number): void => {
    const set = map.get(body) ?? new Set<number>();
    set.add(local);
    map.set(body, set);
  };
  for (const pick of picks) {
    const { body, local } = decodeMeshPick(pick.id);
    if (pick.kind === "vertex") add(selectedVertices, body, local);
    if (pick.kind === "edge") add(selectedEdges, body, local);
  }
  const out: { kind: "face"; id: number }[] = [];
  bodies.forEach((body, bodyIndex) => {
    const verts = selectedVertices.get(bodyIndex);
    const edges = selectedEdges.get(bodyIndex);
    if (!verts || !edges) return;
    meshFaces(body).forEach((face, faceIndex) => {
      if (face.vertices.every((v) => verts.has(v)) && face.edges.every((e) => edges.has(e))) {
        out.push({ kind: "face", id: encodeMeshPick(bodyIndex, faceIndex) });
      }
    });
  });
  return out;
}

export function meshSelectionVertices(
  bodies: readonly MeshBody[],
  picks: readonly { kind: string; id: number }[],
): Map<number, Set<number>> {
  const byBody = new Map<number, Set<number>>();
  const add = (body: number, vertex: number): void => {
    if (!bodies[body]) return;
    if (vertex < 0 || vertex >= meshVertexCount(bodies[body]!)) return;
    const set = byBody.get(body) ?? new Set<number>();
    set.add(vertex);
    byBody.set(body, set);
  };
  for (const pick of picks) {
    const { body, local } = decodeMeshPick(pick.id);
    const mesh = bodies[body];
    if (!mesh) continue;
    if (pick.kind === "vertex") add(body, local);
    if (pick.kind === "face") {
      const face = meshFaces(mesh)[local];
      if (face) for (const vertex of face.vertices) add(body, vertex);
    }
    if (pick.kind === "edge") {
      const segment = meshSegments(mesh)[local];
      if (segment) {
        add(body, segment.a);
        add(body, segment.b);
      }
    }
    if (pick.kind === "body") {
      for (let i = 0; i < meshVertexCount(mesh); i++) add(body, i);
    }
  }
  return byBody;
}

export function translateMeshSelection(
  bodies: readonly MeshBody[],
  picks: readonly { kind: string; id: number }[],
  delta: readonly [number, number, number],
): MeshBody[] {
  const selected = meshSelectionVertices(bodies, picks);
  if (selected.size === 0) return bodies.map(cloneMeshBody);
  return bodies.map((body, bodyIndex) => {
    const verts = selected.get(bodyIndex);
    const next = cloneMeshBody(body);
    if (!verts) return next;
    for (const v of verts) {
      const i = v * 3;
      next.positions[i] = next.positions[i]! + delta[0];
      next.positions[i + 1] = next.positions[i + 1]! + delta[1];
      next.positions[i + 2] = next.positions[i + 2]! + delta[2];
    }
    return next;
  });
}

export function transformMeshSelection(
  bodies: readonly MeshBody[],
  picks: readonly { kind: string; id: number }[],
  matrix: readonly number[],
): MeshBody[] {
  const selected = meshSelectionVertices(bodies, picks);
  if (selected.size === 0) return bodies.map(cloneMeshBody);
  return bodies.map((body, bodyIndex) => {
    const verts = selected.get(bodyIndex);
    const next = cloneMeshBody(body);
    if (!verts) return next;
    for (const v of verts) {
      const i = v * 3;
      const x = next.positions[i]!;
      const y = next.positions[i + 1]!;
      const z = next.positions[i + 2]!;
      next.positions[i] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
      next.positions[i + 1] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
      next.positions[i + 2] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
    }
    return next;
  });
}

export function cloneMeshSelection(
  bodies: readonly MeshBody[],
  picks: readonly { kind: string; id: number }[],
  offset: readonly [number, number, number] = [0.01, 0.01, 0],
): MeshBody[] {
  return bodies.map((body, bodyIndex) => {
    const next = cloneMeshBody(body);
    const cloned = new Map<number, number>();
    const ensureClone = (vertex: number): number => {
      const existing = cloned.get(vertex);
      if (existing != null) return existing;
      const count = meshVertexCount(next);
      const positions = new Float32Array(next.positions.length + 3);
      positions.set(next.positions);
      const src = vertex * 3;
      positions[count * 3] = next.positions[src]! + offset[0];
      positions[count * 3 + 1] = next.positions[src + 1]! + offset[1];
      positions[count * 3 + 2] = next.positions[src + 2]! + offset[2];
      next.positions = positions;
      if (next.normals) {
        const normals = new Float32Array(next.normals.length + 3);
        normals.set(next.normals);
        normals.set(next.normals.subarray(src, src + 3), count * 3);
        next.normals = normals;
      }
      cloned.set(vertex, count);
      return count;
    };
    const appendSegment = (a: number, b: number): void => {
      const existing = next.segments ?? new Uint32Array();
      const segments = new Uint32Array(existing.length + 2);
      segments.set(existing);
      segments[existing.length] = a;
      segments[existing.length + 1] = b;
      next.segments = segments;
    };
    const cloneWholeBody = (): void => {
      const baseCount = meshVertexCount(next);
      const originalPositions = next.positions;
      const positions = new Float32Array(originalPositions.length * 2);
      positions.set(originalPositions);
      for (let i = 0; i < originalPositions.length; i += 3) {
        positions[originalPositions.length + i] = originalPositions[i]! + offset[0];
        positions[originalPositions.length + i + 1] = originalPositions[i + 1]! + offset[1];
        positions[originalPositions.length + i + 2] = originalPositions[i + 2]! + offset[2];
      }
      next.positions = positions;
      if (next.normals) {
        const normals = new Float32Array(next.normals.length * 2);
        normals.set(next.normals);
        normals.set(next.normals, next.normals.length);
        next.normals = normals;
      }
      const indices = new Uint32Array(next.indices.length * 2);
      indices.set(next.indices);
      for (let i = 0; i < next.indices.length; i++) indices[next.indices.length + i] = next.indices[i]! + baseCount;
      next.indices = indices;
      if (next.segments) {
        const originalSegments = next.segments;
        const segments = new Uint32Array(originalSegments.length * 2);
        segments.set(originalSegments);
        for (let i = 0; i < originalSegments.length; i++) segments[originalSegments.length + i] = originalSegments[i]! + baseCount;
        next.segments = segments;
      }
    };
    for (const pick of picks) {
      const ref = decodeMeshPick(pick.id);
      if (ref.body !== bodyIndex) continue;
      if (pick.kind === "body") cloneWholeBody();
      if (pick.kind === "face") {
        const face = meshFaces(body)[ref.local];
        if (!face) continue;
        const clonedFace = face.vertices.map(ensureClone) as [number, number, number];
        const indices = new Uint32Array(next.indices.length + 3);
        indices.set(next.indices);
        indices.set(clonedFace, next.indices.length);
        next.indices = indices;
      }
      if (pick.kind === "vertex") ensureClone(ref.local);
      if (pick.kind === "edge") {
        const segment = meshSegments(body)[ref.local];
        if (!segment) continue;
        appendSegment(ensureClone(segment.a), ensureClone(segment.b));
      }
    }
    return next;
  });
}

// =============================================================================
// §16 Phase 4 — mesh-lane sculpt operations (pure TS, deterministic).
//
// The mesh lane sculpts a `MeshBody` (triangle soup) DIRECTLY, extending the selection
// transforms above with organic tools that a voxel round-trip would blur:
//   • displaceMeshVertices  — a radial brush that moves vertices along their normal;
//   • smoothMeshCotangent   — cotangent-weighted Laplacian smoothing (fairing);
//   • isotropicRemesh       — split long / collapse short edges + tangential relax;
//   • quadricDecimate       — Garland–Heckbert quadric-error-metric decimation;
//   • bakeMeshBodyToSdfDoc  — the CAD→sculpt bake: a tessellated B-rep mesh → an SDF
//                             VoxelDoc so any solid can be sculpt-refined (voxel/sdf.ts).
// =============================================================================

type Vec3 = [number, number, number];

const v3sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const v3len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Falloff weight in [0,1]; smoothstep from centre to rim. */
function meshFalloff(d: number, r: number, kind: "smooth" | "linear" | "constant"): number {
  if (r <= 0 || d >= r) return 0;
  const t = 1 - d / r;
  if (kind === "constant") return 1;
  if (kind === "linear") return t;
  return t * t * (3 - 2 * t);
}

/** Area-weighted per-vertex normals (flat `[x,y,z,…]`) for a mesh body. */
export function computeMeshVertexNormals(body: MeshBody): Float32Array {
  const n = new Float32Array(body.positions.length);
  const p = body.positions;
  for (let i = 0; i + 2 < body.indices.length; i += 3) {
    const a = body.indices[i]! * 3;
    const b = body.indices[i + 1]! * 3;
    const c = body.indices[i + 2]! * 3;
    const ab: Vec3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const ac: Vec3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const cr = v3cross(ab, ac); // area-weighted face normal
    for (const base of [a, b, c]) {
      n[base] = n[base]! + cr[0];
      n[base + 1] = n[base + 1]! + cr[1];
      n[base + 2] = n[base + 2]! + cr[2];
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
    if (l > 1e-20) {
      n[i] = n[i]! / l;
      n[i + 1] = n[i + 1]! / l;
      n[i + 2] = n[i + 2]! / l;
    }
  }
  return n;
}

export interface MeshDisplaceSpec {
  /** World-space brush centre. */
  center: Vec3;
  radius: number;
  /** Signed strength in metres (positive = outward along the normal). */
  strength: number;
  falloff?: "smooth" | "linear" | "constant";
  /** Fixed push direction; defaults to each vertex's own outward normal. */
  direction?: Vec3;
}

/** Radial mesh brush: move every vertex within `radius` of the centre along its normal
 * (or a fixed direction), weighted by falloff. Pure — returns a new MeshBody. */
export function displaceMeshVertices(body: MeshBody, spec: MeshDisplaceSpec): MeshBody {
  const out = cloneMeshBody(body);
  const normals = computeMeshVertexNormals(body);
  const falloff = spec.falloff ?? "smooth";
  const [cx, cy, cz] = spec.center;
  for (let v = 0; v < out.positions.length; v += 3) {
    const dx = out.positions[v]! - cx;
    const dy = out.positions[v + 1]! - cy;
    const dz = out.positions[v + 2]! - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d >= spec.radius) continue;
    const w = meshFalloff(d, spec.radius, falloff);
    if (w === 0) continue;
    const dir: Vec3 = spec.direction ?? [normals[v]!, normals[v + 1]!, normals[v + 2]!];
    const amp = spec.strength * w;
    out.positions[v] = out.positions[v]! + dir[0] * amp;
    out.positions[v + 1] = out.positions[v + 1]! + dir[1] * amp;
    out.positions[v + 2] = out.positions[v + 2]! + dir[2] * amp;
  }
  out.normals = computeMeshVertexNormals(out);
  return out;
}

/** Undirected edge key. */
function ekey(a: number, b: number): number {
  return a < b ? a * 0x100000000 + b : b * 0x100000000 + a;
}

interface CotEdge {
  /** opposite-corner vertices contributing cot weights (one or two). */
  opposite: number[];
}

/** Build cotangent Laplacian weights: per (i,j) edge, Σ cot of its opposite angles. */
function cotangentWeights(positions: ArrayLike<number>, indices: ArrayLike<number>): Map<number, number> {
  const edges = new Map<number, CotEdge>();
  const tris = Math.floor(indices.length / 3);
  const pt = (i: number): Vec3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const cotAt = (o: Vec3, a: Vec3, b: Vec3): number => {
    const u = v3sub(a, o);
    const w = v3sub(b, o);
    const cr = v3len(v3cross(u, w));
    return cr < 1e-20 ? 0 : v3dot(u, w) / cr;
  };
  const weights = new Map<number, number>();
  for (let t = 0; t < tris; t++) {
    const i0 = indices[t * 3]!;
    const i1 = indices[t * 3 + 1]!;
    const i2 = indices[t * 3 + 2]!;
    const corners: [number, number, number][] = [
      [i1, i2, i0], // edge (i1,i2), opposite i0
      [i2, i0, i1],
      [i0, i1, i2],
    ];
    for (const [a, b, o] of corners) {
      const cot = cotAt(pt(o), pt(a), pt(b));
      const key = ekey(a, b);
      weights.set(key, (weights.get(key) ?? 0) + 0.5 * cot);
      if (!edges.has(key)) edges.set(key, { opposite: [] });
    }
  }
  return weights;
}

export interface MeshSmoothSpec {
  iterations?: number;
  /** Step size in [0,1]. */
  lambda?: number;
  /** Optional vertex subset to smooth (all vertices if omitted). */
  selection?: Iterable<number>;
}

/** Cotangent-weighted Laplacian smoothing (mesh fairing). Non-positive weights are clamped
 * to 0 for stability (a common regularization). Pure — returns a new MeshBody. */
export function smoothMeshCotangent(body: MeshBody, spec: MeshSmoothSpec = {}): MeshBody {
  const iterations = Math.max(1, spec.iterations ?? 1);
  const lambda = spec.lambda ?? 0.5;
  const nVerts = meshVertexCount(body);
  const selected = spec.selection ? new Set(spec.selection) : null;
  let pos = new Float32Array(body.positions);

  // Fixed adjacency (recomputed weights each pass would track motion; for stability and
  // determinism we use the rest-pose cotangent weights, the standard uniform-time scheme).
  const weights = cotangentWeights(body.positions, body.indices);
  // Build per-vertex neighbour list from the weighted edges.
  const neighbours = new Map<number, number[]>();
  for (const key of weights.keys()) {
    const a = Math.floor(key / 0x100000000);
    const b = key % 0x100000000;
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push(a);
  }

  for (let it = 0; it < iterations; it++) {
    const next = new Float32Array(pos);
    for (let i = 0; i < nVerts; i++) {
      if (selected && !selected.has(i)) continue;
      const nb = neighbours.get(i);
      if (!nb || nb.length === 0) continue;
      let sw = 0;
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const j of nb) {
        const w = Math.max(0, weights.get(ekey(i, j)) ?? 0);
        if (w === 0) continue;
        sw += w;
        ax += w * pos[j * 3]!;
        ay += w * pos[j * 3 + 1]!;
        az += w * pos[j * 3 + 2]!;
      }
      if (sw <= 0) continue;
      // v_i += λ (Σ w_ij v_j / Σ w_ij − v_i)
      next[i * 3] = pos[i * 3]! + lambda * (ax / sw - pos[i * 3]!);
      next[i * 3 + 1] = pos[i * 3 + 1]! + lambda * (ay / sw - pos[i * 3 + 1]!);
      next[i * 3 + 2] = pos[i * 3 + 2]! + lambda * (az / sw - pos[i * 3 + 2]!);
    }
    pos = next;
  }

  const out = cloneMeshBody(body);
  out.positions = pos;
  out.normals = computeMeshVertexNormals(out);
  return out;
}

// --- isotropic remesh -------------------------------------------------------

interface MutMesh {
  pos: number[]; // flat xyz
  tris: number[]; // flat triples
}

function bodyToMut(body: MeshBody): MutMesh {
  return { pos: Array.from(body.positions), tris: Array.from(body.indices) };
}

function mutToBody(m: MutMesh, template: MeshBody): MeshBody {
  const out = cloneMeshBody(template);
  out.positions = new Float32Array(m.pos);
  out.indices = new Uint32Array(m.tris);
  delete (out as { segments?: Uint32Array }).segments;
  out.normals = computeMeshVertexNormals(out);
  return out;
}

/** Drop unused vertices and compact indices. */
function compactMut(m: MutMesh): MutMesh {
  const used = new Set<number>();
  for (const idx of m.tris) used.add(idx);
  const remap = new Map<number, number>();
  const pos: number[] = [];
  for (const v of Array.from(used).sort((a, b) => a - b)) {
    remap.set(v, pos.length / 3);
    pos.push(m.pos[v * 3]!, m.pos[v * 3 + 1]!, m.pos[v * 3 + 2]!);
  }
  const tris = m.tris.map((v) => remap.get(v)!);
  return { pos, tris };
}

function triVerts(m: MutMesh, t: number): [number, number, number] {
  return [m.tris[t * 3]!, m.tris[t * 3 + 1]!, m.tris[t * 3 + 2]!];
}
function vertOf(m: MutMesh, v: number): Vec3 {
  return [m.pos[v * 3]!, m.pos[v * 3 + 1]!, m.pos[v * 3 + 2]!];
}
function edgeLen(m: MutMesh, a: number, b: number): number {
  return v3len(v3sub(vertOf(m, a), vertOf(m, b)));
}

/** Split every edge longer than `high` at its midpoint (shared across the two incident
 * triangles), one pass; returns whether any split happened. */
function splitLongEdges(m: MutMesh, high: number): boolean {
  const midpoints = new Map<number, number>();
  const newTris: number[] = [];
  let split = false;
  const midOf = (a: number, b: number): number | null => {
    if (edgeLen(m, a, b) <= high) return null;
    const key = ekey(a, b);
    const cached = midpoints.get(key);
    if (cached !== undefined) return cached;
    const va = vertOf(m, a);
    const vb = vertOf(m, b);
    const id = m.pos.length / 3;
    m.pos.push((va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2);
    midpoints.set(key, id);
    return id;
  };
  const triCount = m.tris.length / 3;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triVerts(m, t);
    const mab = midOf(a, b);
    const mbc = midOf(b, c);
    const mca = midOf(c, a);
    const count = (mab !== null ? 1 : 0) + (mbc !== null ? 1 : 0) + (mca !== null ? 1 : 0);
    if (count === 0) {
      newTris.push(a, b, c);
      continue;
    }
    split = true;
    if (count === 3) {
      newTris.push(a, mab!, mca!, mab!, b, mbc!, mca!, mbc!, c, mab!, mbc!, mca!);
    } else if (mab !== null && mbc !== null) {
      newTris.push(a, mab!, mbc!, a, mbc!, c, mab!, b, mbc!);
    } else if (mbc !== null && mca !== null) {
      newTris.push(b, mbc!, mca!, b, mca!, a, mbc!, c, mca!);
    } else if (mca !== null && mab !== null) {
      newTris.push(c, mca!, mab!, c, mab!, b, mca!, a, mab!);
    } else if (mab !== null) {
      newTris.push(a, mab!, c, mab!, b, c);
    } else if (mbc !== null) {
      newTris.push(b, mbc!, a, mbc!, c, a);
    } else if (mca !== null) {
      newTris.push(c, mca!, b, mca!, a, b);
    }
  }
  m.tris = newTris;
  return split;
}

/** Collapse edges shorter than `low` by merging to the midpoint (one greedy pass). */
function collapseShortEdges(m: MutMesh, low: number): boolean {
  const touched = new Set<number>();
  const remap = new Map<number, number>();
  const resolve = (v: number): number => {
    let r = v;
    while (remap.has(r)) r = remap.get(r)!;
    return r;
  };
  const triCount = m.tris.length / 3;
  let collapsed = false;
  const edgesSeen = new Set<number>();
  for (let t = 0; t < triCount; t++) {
    const vs = triVerts(m, t);
    for (let e = 0; e < 3; e++) {
      const a0 = vs[e]!;
      const b0 = vs[(e + 1) % 3]!;
      const a = resolve(a0);
      const b = resolve(b0);
      if (a === b) continue;
      const key = ekey(a, b);
      if (edgesSeen.has(key)) continue;
      edgesSeen.add(key);
      if (touched.has(a) || touched.has(b)) continue;
      if (edgeLen(m, a, b) >= low) continue;
      // Merge b → a at the midpoint.
      const va = vertOf(m, a);
      const vb = vertOf(m, b);
      m.pos[a * 3] = (va[0] + vb[0]) / 2;
      m.pos[a * 3 + 1] = (va[1] + vb[1]) / 2;
      m.pos[a * 3 + 2] = (va[2] + vb[2]) / 2;
      remap.set(b, a);
      touched.add(a);
      touched.add(b);
      collapsed = true;
    }
  }
  if (!collapsed) return false;
  // Rewrite triangles through the remap, dropping degenerates.
  const newTris: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triVerts(m, t).map(resolve) as [number, number, number];
    if (a === b || b === c || a === c) continue;
    newTris.push(a, b, c);
  }
  m.tris = newTris;
  return true;
}

/** Tangential Laplacian relaxation (uniform weights) — evens out vertex spacing. */
function relaxTangential(m: MutMesh, lambda: number): void {
  const nVerts = m.pos.length / 3;
  const neigh: Set<number>[] = Array.from({ length: nVerts }, () => new Set<number>());
  const triCount = m.tris.length / 3;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triVerts(m, t);
    neigh[a]!.add(b).add(c);
    neigh[b]!.add(a).add(c);
    neigh[c]!.add(a).add(b);
  }
  const next = m.pos.slice();
  for (let i = 0; i < nVerts; i++) {
    const nb = neigh[i]!;
    if (nb.size === 0) continue;
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (const j of nb) {
      ax += m.pos[j * 3]!;
      ay += m.pos[j * 3 + 1]!;
      az += m.pos[j * 3 + 2]!;
    }
    const inv = 1 / nb.size;
    next[i * 3] = m.pos[i * 3]! + lambda * (ax * inv - m.pos[i * 3]!);
    next[i * 3 + 1] = m.pos[i * 3 + 1]! + lambda * (ay * inv - m.pos[i * 3 + 1]!);
    next[i * 3 + 2] = m.pos[i * 3 + 2]! + lambda * (az * inv - m.pos[i * 3 + 2]!);
  }
  m.pos = next;
}

export interface RemeshSpec {
  /** Target uniform edge length in metres. */
  targetEdgeLength: number;
  /** Split/collapse + relax passes (default 3). */
  iterations?: number;
}

/** Isotropic remesh toward a uniform edge length (Botsch–Kobbelt style: split long edges
 * above 4/3·L, collapse short edges below 4/5·L, then tangential relaxation). Pure TS. */
export function isotropicRemesh(body: MeshBody, spec: RemeshSpec): MeshBody {
  const L = spec.targetEdgeLength;
  if (!(L > 0)) throw new Error("isotropicRemesh: targetEdgeLength must be > 0");
  const high = (4 / 3) * L;
  const low = (4 / 5) * L;
  const passes = Math.max(1, spec.iterations ?? 3);
  let m = bodyToMut(body);
  for (let it = 0; it < passes; it++) {
    splitLongEdges(m, high);
    collapseShortEdges(m, low);
    m = compactMut(m);
    relaxTangential(m, 0.5);
  }
  return mutToBody(m, body);
}

// --- quadric-error-metric decimation (Garland–Heckbert) ---------------------

/** A symmetric 4×4 quadric stored as its 10 upper-triangular coefficients. */
type Quadric = Float64Array; // [q0=a²,q1=ab,q2=ac,q3=ad,q4=b²,q5=bc,q6=bd,q7=c²,q8=cd,q9=d²]

function planeQuadric(a: number, b: number, c: number, d: number): Quadric {
  return Float64Array.of(a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d);
}
function addQuadric(into: Quadric, q: Quadric): void {
  for (let i = 0; i < 10; i++) into[i] = into[i]! + q[i]!;
}
function quadricError(q: Quadric, x: number, y: number, z: number): number {
  return (
    q[0]! * x * x + 2 * q[1]! * x * y + 2 * q[2]! * x * z + 2 * q[3]! * x +
    q[4]! * y * y + 2 * q[5]! * y * z + 2 * q[6]! * y +
    q[7]! * z * z + 2 * q[8]! * z +
    q[9]!
  );
}

/** The collapse position that minimizes the merged quadric error, chosen from the two
 * endpoints and their midpoint (subset placement — robust and never invents a far-off
 * point, so sharp extrema like corners are preserved and the error stays bounded). */
function optimalPosition(q: Quadric, va: Vec3, vb: Vec3): Vec3 {
  const mid: Vec3 = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
  const cands: Vec3[] = [va, vb, mid];
  let best = cands[0]!;
  let bestErr = Infinity;
  for (const c of cands) {
    const e = quadricError(q, c[0], c[1], c[2]);
    if (e < bestErr) {
      bestErr = e;
      best = c;
    }
  }
  return best;
}

export interface DecimateSpec {
  /** Target triangle count (takes precedence). */
  targetTriangles?: number;
  /** Fraction of triangles to KEEP (0..1) when targetTriangles is absent. */
  targetRatio?: number;
}

/** Quadric-error-metric mesh decimation (Garland–Heckbert): iteratively collapse the
 * lowest-cost edge until the triangle target is met. Pure TS, deterministic. */
export function quadricDecimate(body: MeshBody, spec: DecimateSpec): MeshBody {
  let m = compactMut(bodyToMut(body));
  const startTris = m.tris.length / 3;
  const target = spec.targetTriangles ?? Math.max(1, Math.round(startTris * (spec.targetRatio ?? 0.5)));
  if (startTris <= target || startTris < 4) return mutToBody(m, body);

  const remap = new Map<number, number>();
  const resolve = (v: number): number => {
    let r = v;
    while (remap.has(r)) r = remap.get(r)!;
    return r;
  };

  const rebuildQuadrics = (): Quadric[] => {
    const nVerts = m.pos.length / 3;
    const Q: Quadric[] = Array.from({ length: nVerts }, () => new Float64Array(10));
    const triCount = m.tris.length / 3;
    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = triVerts(m, t);
      const pa = vertOf(m, a);
      const pb = vertOf(m, b);
      const pc = vertOf(m, c);
      const nrm = v3cross(v3sub(pb, pa), v3sub(pc, pa));
      const len = v3len(nrm);
      if (len < 1e-20) continue;
      const nx = nrm[0] / len;
      const ny = nrm[1] / len;
      const nz = nrm[2] / len;
      const d = -(nx * pa[0] + ny * pa[1] + nz * pa[2]);
      const q = planeQuadric(nx, ny, nz, d);
      addQuadric(Q[a]!, q);
      addQuadric(Q[b]!, q);
      addQuadric(Q[c]!, q);
    }
    return Q;
  };

  let liveTris = startTris;
  let guard = startTris * 3 + 16;
  while (liveTris > target && guard-- > 0) {
    const Q = rebuildQuadrics();
    // Find the lowest-cost collapsible edge among current triangles.
    const seen = new Set<number>();
    let bestErr = Infinity;
    let bestA = -1;
    let bestB = -1;
    let bestPos: Vec3 = [0, 0, 0];
    const triCount = m.tris.length / 3;
    for (let t = 0; t < triCount; t++) {
      const vs = triVerts(m, t);
      for (let e = 0; e < 3; e++) {
        const a = vs[e]!;
        const b = vs[(e + 1) % 3]!;
        if (a === b) continue;
        const key = ekey(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        const q = new Float64Array(Q[a]!);
        addQuadric(q, Q[b]!);
        const pos = optimalPosition(q, vertOf(m, a), vertOf(m, b));
        const err = quadricError(q, pos[0], pos[1], pos[2]);
        if (err < bestErr) {
          bestErr = err;
          bestA = a;
          bestB = b;
          bestPos = pos;
        }
      }
    }
    if (bestA < 0) break;
    // Collapse b → a at the optimal position.
    m.pos[bestA * 3] = bestPos[0];
    m.pos[bestA * 3 + 1] = bestPos[1];
    m.pos[bestA * 3 + 2] = bestPos[2];
    remap.clear();
    remap.set(bestB, bestA);
    const newTris: number[] = [];
    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = triVerts(m, t).map(resolve) as [number, number, number];
      if (a === b || b === c || a === c) continue;
      newTris.push(a, b, c);
    }
    m.tris = newTris;
    m = compactMut(m);
    liveTris = m.tris.length / 3;
  }
  return mutToBody(m, body);
}

/** CAD→sculpt bridge: bake a tessellated B-rep mesh body into a narrow-band SDF VoxelDoc
 * so any solid can be sculpt-refined and round-tripped back through reconstruct. Pure TS
 * (mesh distance field, voxel/sdf.ts). `voxelSize` sets the sculpt resolution. */
export function bakeMeshBodyToSdfDoc(
  body: MeshBody,
  opts: { voxelSize: number; band?: number; margin?: number; name?: string },
): VoxelDoc {
  const g = SdfGrid.fromMesh(body.positions, body.indices, {
    voxelSize: opts.voxelSize,
    ...(opts.band !== undefined ? { band: opts.band } : {}),
    ...(opts.margin !== undefined ? { margin: opts.margin } : {}),
  });
  return g.toDoc(opts.name);
}
