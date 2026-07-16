// Tagged-mesh types — the typed-selection keystone (ADR-0013 / SPEC-4 FR-16).
//
// A solid tessellates into ONE mesh whose triangles are partitioned into
// per-face render groups, plus per-edge polylines and per-B-rep-corner points.
// Each face/edge carries a *persistent signature* (a face's outward normal; an
// edge's two adjacent-face normals) so a selection survives a parametric
// rebuild: the transient integer id is only valid for the current mesh, while
// the signature re-resolves the same topology after upstream edits.

// Public tagged-mesh types use MUTABLE [x,y,z] tuples to match the app's
// worker/protocol contract (which transfers them as plain arrays).
type V3 = [number, number, number];

/**
 * A persistent reference to a face. The outward unit normal is the primary
 * signature; `centroid` (the face's area centroid) is an OPTIONAL positional
 * disambiguator that distinguishes two faces sharing the same normal (coplanar
 * faces, a step, parallel walls). Optional so refs persisted before it existed
 * still resolve (by normal alone). New captures include it.
 */
export interface FaceRef {
  readonly normal: V3;
  readonly centroid?: V3;
}

/**
 * A persistent reference to an edge: the two adjacent faces' normals (primary
 * signature) plus an OPTIONAL `midpoint` positional disambiguator that separates
 * parallel edges sharing the same adjacent-normal pair. Optional for the same
 * back-compat reason as {@link FaceRef.centroid}.
 */
export interface EdgeRef {
  readonly faceNormals: readonly [V3, V3];
  readonly midpoint?: V3;
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
  readonly normal: V3;
  /** The face's area centroid — the FaceRef positional disambiguator (separates
   * two faces sharing `normal`). SI metres. */
  readonly centroid: V3;
}

/** One B-rep edge as a world-space polyline plus its persistent signature. */
export interface TaggedEdge {
  readonly edgeId: number;
  /** Flat `[x0,y0,z0, x1,y1,z1, …]` polyline vertices in SI metres. */
  readonly positions: number[];
  /** The two adjacent faces' normals — the persistent EdgeRef signature. */
  readonly faceNormals: readonly [V3, V3];
  /** The two adjacent face-group ids (transient, this-mesh only), in the SAME order as
   * `faceNormals` — so a traversal can reach each adjacent face's centroid for the dihedral
   * convexity test (M2 / select/topology.ts; docs/adr/0002). A seam edge bordering one face has
   * both ids equal. */
  readonly faceIds: readonly [number, number];
  /** The edge's mid-parameter point — the EdgeRef positional disambiguator
   * (separates parallel edges sharing `faceNormals`). SI metres. */
  readonly midpoint: V3;
}

/** One B-rep corner vertex. */
export interface VertexPoint {
  readonly vertexId: number;
  readonly position: V3;
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
  /**
   * Number of B-rep faces that carried no triangulation and were therefore
   * OMITTED from `faceGroups`/`vertices`/`indices`. `0` for a complete mesh; a
   * non-zero value means the mesh is partial (a hole where those faces were) —
   * consumers (e.g. glTF export, the rebuild status) must surface it rather than
   * treat the shorter mesh as the full geometry.
   */
  readonly droppedFaces: number;
  /**
   * Number of B-rep edges OMITTED from `edges` because an adjacent face had no
   * triangulation (each such face is already counted in `droppedFaces`, so
   * `droppedEdges > 0` implies `droppedFaces > 0`). The emitted edges keep
   * compact consecutive `edgeId`s (`edges[e.edgeId] === e`) — a skipped edge
   * leaves no gap in the numbering.
   */
  readonly droppedEdges: number;
  /**
   * Number of edge-adjacent face-id lookups (two per emitted edge) that matched
   * no face group — that slot of the edge's `faceIds` is `-1`, which the
   * traversal layer (select/topology.ts) treats as missing data (the edge
   * classifies as "smooth" and contributes no adjacency). `0` for a complete
   * mesh. Distinct faces that merely SHARE an area centroid (a shelled tube's
   * inner/outer lateral walls) are NOT counted here: those resolve exactly, by
   * B-rep identity.
   */
  readonly unresolvedEdgeFaces: number;
}

/** Tessellation quality knobs. */
export interface TessellateOptions {
  /** Linear deflection in SI metres (smaller = finer). Default 1e-4 (0.1 mm). */
  readonly linearDeflection?: number;
  /** Angular deflection in radians. Default 0.5. */
  readonly angularDeflection?: number;
}
