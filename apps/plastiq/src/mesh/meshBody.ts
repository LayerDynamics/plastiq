// SPEC-6 R4.1 — the mesh-body representation (decision 5/20). A MeshBody is a plain
// triangle soup (SI metres) for generated/imported organic geometry that the OCCT
// B-rep kernel cannot author. It lives in the APP (not @plastiq/cad) because it is a
// three.js-rendered, display-oriented artifact and `three` is an app dependency
// (decision 24); the kernel stays B-rep-only.

export interface MeshMaterial {
  /** Base colour as 0xRRGGBB. */
  color?: number;
  metalness?: number;
  roughness?: number;
  opacity?: number;
}

export interface MeshBody {
  /** Flat `[x0,y0,z0, …]` vertices in SI metres (world space). */
  positions: Float32Array;
  /** Flat triangle indices into `positions` (groups of 3). */
  indices: Uint32Array;
  /** Optional standalone line segments into `positions` (pairs of vertex indices). */
  segments?: Uint32Array;
  /** Optional per-vertex normals (flat `[x,y,z,…]`), parallel to `positions`. */
  normals?: Float32Array;
  material?: MeshMaterial;
}

/** JSON-safe form used when a generated/imported mesh has direct vertex edits. */
export interface SerializedMeshBody {
  positions: number[];
  indices: number[];
  segments?: number[];
  normals?: number[];
  material?: MeshMaterial;
}

export function cloneMeshBody(body: MeshBody): MeshBody {
  return {
    positions: new Float32Array(body.positions),
    indices: new Uint32Array(body.indices),
    ...(body.segments ? { segments: new Uint32Array(body.segments) } : {}),
    ...(body.normals ? { normals: new Float32Array(body.normals) } : {}),
    ...(body.material ? { material: { ...body.material } } : {}),
  };
}

export function serializeMeshBody(body: MeshBody): SerializedMeshBody {
  return {
    positions: Array.from(body.positions),
    indices: Array.from(body.indices),
    ...(body.segments ? { segments: Array.from(body.segments) } : {}),
    ...(body.normals ? { normals: Array.from(body.normals) } : {}),
    ...(body.material ? { material: { ...body.material } } : {}),
  };
}

export function deserializeMeshBody(body: SerializedMeshBody): MeshBody {
  return {
    positions: new Float32Array(body.positions),
    indices: new Uint32Array(body.indices),
    ...(body.segments ? { segments: new Uint32Array(body.segments) } : {}),
    ...(body.normals ? { normals: new Float32Array(body.normals) } : {}),
    ...(body.material ? { material: { ...body.material } } : {}),
  };
}

/** Triangle count of a mesh body. */
export function meshBodyTriangleCount(body: MeshBody): number {
  return Math.floor(body.indices.length / 3);
}

/** Axis-aligned bounding box of a mesh body (SI metres), or null if empty. */
export function meshBodyBounds(body: MeshBody): { min: [number, number, number]; max: [number, number, number] } | null {
  const p = body.positions;
  if (p.length < 3) return null;
  const min: [number, number, number] = [p[0]!, p[1]!, p[2]!];
  const max: [number, number, number] = [p[0]!, p[1]!, p[2]!];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}
