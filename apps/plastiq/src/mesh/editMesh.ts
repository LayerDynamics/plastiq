import type { MeshBody } from "./meshBody.js";
import { cloneMeshBody } from "./meshBody.js";

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
