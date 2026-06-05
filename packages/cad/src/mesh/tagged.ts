// Tagged-mesh types — the typed-selection keystone (ADR-0013 / SPEC-4 FR-16).
//
// A solid tessellates into ONE mesh whose triangles are partitioned into
// per-face render groups, plus per-edge polylines and per-B-rep-corner points.
// Each face/edge carries a *persistent signature* (a face's outward normal; an
// edge's two adjacent-face normals) so a selection survives a parametric
// rebuild: the transient integer id is only valid for the current mesh, while
// the signature re-resolves the same topology after upstream edits.

import type { Vec3 } from "../math/index.js";

/** A persistent reference to a face: its outward unit normal signature. */
export interface FaceRef {
  readonly normal: Vec3;
}

/** A persistent reference to an edge: the two adjacent faces' normals. */
export interface EdgeRef {
  readonly faceNormals: readonly [Vec3, Vec3];
}

/** One face's triangles as a contiguous range of the shared index buffer. */
export interface FaceGroup {
  /** First index (into `TaggedMesh.indices`) of this face's triangles. */
  readonly start: number;
  /** Number of indices in this face's run (always a multiple of 3). */
  readonly count: number;
  /** Transient face id, stable within this mesh (its render-group order). */
  readonly faceId: number;
  /** The face's outward unit normal — its persistent FaceRef signature. */
  readonly normal: Vec3;
}

/** One B-rep edge as a world-space polyline plus its persistent signature. */
export interface TaggedEdge {
  readonly edgeId: number;
  /** Flat `[x0,y0,z0, x1,y1,z1, …]` polyline vertices in SI metres. */
  readonly positions: number[];
  /** The two adjacent faces' normals — the persistent EdgeRef signature. */
  readonly faceNormals: readonly [Vec3, Vec3];
}

/** One B-rep corner vertex. */
export interface VertexPoint {
  readonly vertexId: number;
  readonly position: Vec3;
}

/** The full tagged tessellation of a solid. */
export interface TaggedMesh {
  /** Flat `[x,y,z, …]` triangle vertices (SI metres). */
  readonly vertices: number[];
  /** Flat triangle indices into `vertices` (groups of 3). */
  readonly indices: number[];
  readonly faceGroups: FaceGroup[];
  readonly edges: TaggedEdge[];
  readonly vertexPoints: VertexPoint[];
}

/** Tessellation quality knobs. */
export interface TessellateOptions {
  /** Linear deflection in SI metres (smaller = finer). Default 1e-4 (0.1 mm). */
  readonly deflection?: number;
  /** Angular deflection in radians. Default 0.5. */
  readonly angularDeflection?: number;
}
