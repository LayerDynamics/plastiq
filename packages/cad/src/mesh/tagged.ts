// Tagged-mesh types — the typed-selection keystone (ADR-0013 / SPEC-4 FR-16).
//
// A solid tessellates into ONE mesh whose triangles are partitioned into
// per-face render groups, plus per-edge polylines and per-B-rep-corner points.
// Each face/edge carries a *persistent signature* (a face's outward normal; an
// edge's two adjacent-face normals) so a selection survives a parametric
// rebuild: the transient integer id is only valid for the current mesh, while
// the signature re-resolves the same topology after upstream edits.

import type { BodyKind } from "../solid/bodyKind.js";
import type { SurfaceSignature } from "./surface.js";

export type { BodyKind, SurfaceSignature };

// Public tagged-mesh types use MUTABLE [x,y,z] tuples to match the app's
// worker/protocol contract (which transfers them as plain arrays).
type V3 = [number, number, number];

/**
 * A persistent reference to a face.
 *
 * `surface` is the PRIMARY signature: the face's analytic identity (plane
 * normal+origin, cylinder axis+radius, sphere centre+radius, …) read straight
 * off the B-rep surface. It is exact and mesh-independent, and it is the only
 * signature that works for a CLOSED curved face — such a face's averaged
 * triangulation normal integrates to zero, leaving `normal` below as
 * meaningless floating-point residue (§2.1).
 *
 * `normal` + `centroid` remain for two reasons: they still resolve refs
 * persisted before `surface` existed (back-compat — `surface` is optional), and
 * `centroid` disambiguates two faces that share the SAME analytic surface
 * (e.g. two coplanar fragments, or the two walls of a through-hole cut, which
 * are the same cylinder).
 */
export interface FaceRef {
  readonly normal: V3;
  readonly centroid?: V3;
  /** Analytic surface identity (§2.1). Absent on refs persisted before it existed. */
  readonly surface?: SurfaceSignature;
}

/**
 * A persistent reference to an edge.
 *
 * `faceSurfaces` is the PRIMARY signature: the two adjacent faces' analytic
 * identities. `faceNormals` alone cannot describe an edge bordering a closed
 * curved wall (a hole rim, a boss edge) — that side's averaged normal is
 * residue, so the old summed-dot score could never reach its threshold and such
 * an edge never re-resolved (§2.1).
 *
 * `faceNormals` + `midpoint` remain for back-compat (refs persisted before
 * `faceSurfaces` existed) and because `midpoint` still separates parallel edges
 * sharing the same adjacent surfaces.
 */
export interface EdgeRef {
  readonly faceNormals: readonly [V3, V3];
  readonly midpoint?: V3;
  /** The adjacent faces' analytic surfaces (§2.1). Absent on older refs. */
  readonly faceSurfaces?: readonly [SurfaceSignature, SurfaceSignature];
}

/**
 * A persistent reference to a B-rep corner vertex (§12.R12).
 *
 * A vertex, unlike a face or edge, has NO analytic surface identity — there is
 * no plane/cylinder signature to read off it. Its `position` (the exact B-rep
 * corner point, via `BRep_Tool.Pnt`) is therefore the PRIMARY and only intrinsic
 * signature: {@link resolveVertexRef} re-binds the nearest vertex within the
 * model's bounding-box diagonal after a parametric rebuild. This is what lets a
 * measure endpoint or a §13 hole/point placement survive an upstream edit,
 * mirroring how {@link FaceRef}/{@link EdgeRef} survive via their signatures.
 *
 * `adjacentEdgeMidpoints` is the optional positional disambiguator — the
 * midpoints of the edges meeting at this corner, the analogue of
 * {@link FaceRef}'s `centroid` and {@link EdgeRef}'s `midpoint`. It separates two
 * vertices that share the SAME position (the coincident corners of two bodies in
 * a compound / a non-manifold touch): those score identically on position, so
 * the closest adjacent-edge-midpoint set decides. Within a single well-formed
 * solid OCCT sews each corner into ONE `TopoDS_Vertex`, so position alone is
 * unambiguous there and this field may be omitted.
 */
export interface VertexRef {
  readonly position: V3;
  readonly adjacentEdgeMidpoints?: readonly V3[];
}

/** One face's triangles as a contiguous range of the shared index buffer. */
export interface FaceGroup {
  /** First index (into `TaggedMesh.indices`) of this face's triangles. */
  readonly start: number;
  /** Number of indices in this face's run (always a multiple of 3). */
  readonly count: number;
  /** Transient face id, stable within this mesh (its render-group order). */
  readonly faceId: number;
  /** The face's outward unit normal. MEANINGLESS for a closed curved face (its
   * area-weighted average integrates to zero) — see {@link FaceRef} and
   * `surface` below, which is the signature that actually identifies it (§2.1). */
  readonly normal: V3;
  /** The face's area centroid — the FaceRef positional disambiguator (separates
   * two faces sharing the same surface). SI metres. */
  readonly centroid: V3;
  /** The face's ANALYTIC surface identity — the primary FaceRef signature (§2.1). */
  readonly surface: SurfaceSignature;
}

/** One B-rep edge as a world-space polyline plus its persistent signature. */
export interface TaggedEdge {
  readonly edgeId: number;
  /** Flat `[x0,y0,z0, x1,y1,z1, …]` polyline vertices in SI metres. */
  readonly positions: number[];
  /** The two adjacent faces' normals. Residue on any side that is a closed
   * curved wall — `faceSurfaces` is the signature that identifies such an edge (§2.1). */
  readonly faceNormals: readonly [V3, V3];
  /** The two adjacent faces' ANALYTIC surfaces, in the SAME order as
   * `faceNormals` — the primary EdgeRef signature (§2.1). */
  readonly faceSurfaces: readonly [SurfaceSignature, SurfaceSignature];
  /** The two adjacent face-group ids (transient, this-mesh only), in the SAME order as
   * `faceNormals` — so a traversal can reach each adjacent face's centroid for the dihedral
   * convexity test (M2 / select/topology.ts; docs/adr/0002). A seam edge bordering one face has
   * both ids equal. */
  readonly faceIds: readonly [number, number];
  /** The edge's mid-parameter point — the EdgeRef positional disambiguator
   * (separates parallel edges sharing `faceNormals`). SI metres. */
  readonly midpoint: V3;
  /**
   * True when this edge is free (naked) on an open shell/face — only one face
   * ancestor (§14 free-edge highlighting). Omitted / false on closed solids so
   * cylindrical seam edges (also one-face in MapShapesAndAncestors) are not
   * mis-flagged. Optional for back-compat with partial fixtures.
   */
  readonly isFree?: boolean;
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
  /**
   * Body-kind discriminator (§11 / §17) — `"solid" | "shell" | "face" | …`.
   * Optional so partial test fixtures need not supply it; real tessellation
   * always sets it from the shape's TopAbs type.
   */
  readonly bodyKind?: BodyKind;
  /**
   * Free (naked) edge count from ShapeAnalysis_FreeBounds (§14). Zero on a
   * watertight solid; positive on open shells/faces. Optional for back-compat.
   */
  readonly freeEdgeCount?: number;
}

/** Tessellation quality knobs. */
export interface TessellateOptions {
  /** Linear deflection in SI metres (smaller = finer). Default 1e-4 (0.1 mm). */
  readonly linearDeflection?: number;
  /** Angular deflection in radians. Default 0.5. */
  readonly angularDeflection?: number;
}
