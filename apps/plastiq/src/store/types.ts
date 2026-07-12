// CAD Studio document + selection types (SPEC-5 FR-2).
import type { AssemblyModel } from "../assembly/model.js";
import type { SerializedMeshBody } from "../mesh/meshBody.js";
//
// The document is a superset of the kernel's serializable ModelDoc (SPEC-4
// FR-34): an ordered list of declarative feature specs + named parameters, so it
// persists and reloads reproducibly. The editor adds non-geometric fields (name,
// suppression) and a `data` bag for non-numeric feature payloads (sketch points,
// persistent edge/face references) that later milestones populate.

/** Stable string ids (`f1`, `f2`, …) — match the kernel FeatureSpec id form. */
export type FeatureId = string;

/** Feature type tag for a body placement (the M1.3 gizmo pose). Distinct from
 * the M2.5 "transform" feature (baked SPEC-4 translate/rotate/mirror). */
export const PLACEMENT_TYPE = "placement";

/** A feature in the editable history. `params` are the kernel's numeric spec
 * params; `data` carries non-numeric payloads (e.g. sketch points, EdgeRef[]). */
export interface EditorFeature {
  readonly id: FeatureId;
  /** Feature type tag: "sketch" | "extrude" | "fillet" | "chamfer" | … */
  readonly type: string;
  /** User-facing name (defaults to a type-derived label). */
  name?: string;
  /** Upstream feature ids this one consumes. */
  deps?: FeatureId[];
  /** Numeric parameters (kernel-serializable). */
  params?: Record<string, number>;
  /** Non-numeric payload (sketch geometry, selection refs, enums). */
  data?: Record<string, unknown>;
  /** Suppressed features are skipped during rebuild but kept in the tree. */
  suppressed?: boolean;
}

/** The serializable document. The optional `assembly` holds component instances
 * of this part + their mates (SPEC-5 M4); absent for a plain single-part doc. */
export interface CadDocument {
  readonly features: EditorFeature[];
  readonly params: Record<string, number>;
  readonly assembly?: AssemblyModel;
}

/** How a mesh document was generated. The first three are the creative gen path (SPEC-6 R4);
 * `photos3d` is the NeRF/surface-capture path (SPEC-11 N11) — posed photos → a trained surface;
 * `voxel` records a mesh staged from a voxel sculpt's surface (the ADR-0010 Convert-to-CAD handoff). */
export interface MeshSource {
  mode: "text2img3d" | "img3d" | "text3d" | "photos3d" | "voxel";
  providerId: string;
  prompt?: string;
  imageId?: string;
}

/** A generated mesh document — a separate document KIND from the parametric
 * CadDocument (SPEC-6 decision 20: a project is parametric OR mesh, not mixed).
 * Geometry is re-derived from the stored GLB (base64) via importGltf on load,
 * mirroring how an importStep feature re-imports its STEP text. */
export interface MeshDoc {
  readonly kind: "mesh";
  name?: string;
  /** The generated model as a base64 GLB (JSON-safe; re-parsed on load). */
  glb: string;
  /** Optional direct mesh edits; absent means re-derive geometry from `glb`. */
  editedBodies?: SerializedMeshBody[];
  source: MeshSource;
}

/** An opt-in voxel-sculpt document (M10). A dense occupancy grid persisted compactly as the linear
 * indices of its occupied cells; the grid is re-derived on load (voxel/doc.ts). Like a MeshDoc it is
 * a non-parametric mode (B-rep ops don't apply); its surface mesh feeds reconstruct (mesh→B-rep).
 *
 * A full member of `PersistedDoc`: projectsStore opens/saves/autosaves/recovers voxel projects, the
 * Sculpt workspace edits them (voxel/voxelStore.ts + three/VoxelSculpt.tsx), and the Convert-to-CAD
 * handoff stages the surface mesh as a MeshDoc for the existing reconstruct path (docs/adr/0010). */
export interface VoxelDoc {
  readonly kind: "voxel";
  name?: string;
  dims: [number, number, number];
  voxelSize: number;
  origin: [number, number, number];
  /** Occupied cell linear indices, `(z·ny + y)·nx + x`. */
  cells: number[];
}

/** How a point cloud entered the app. `photos3d` = the photogrammetry dense cloud (SPEC-13),
 * `scan` = the capture service's oriented cloud, `import` = a dropped .ply/.xyz/.json file. */
export interface PointCloudSource {
  mode: "photos3d" | "scan" | "import";
  providerId: string;
}

/** A dense point-cloud document (SPEC-13): the raw oriented cloud a photogrammetry/scan pipeline
 * produces, shown on the SAME canvas as a THREE.Points cloud rather than discarded at
 * reconstruction. Like MeshDoc/VoxelDoc it is a non-parametric mode (no B-rep ops); its points feed
 * the capture service (cloud→mesh) or completion (partial→full). Buffers are stored as flat JSON
 * number[] triples (x0,y0,z0,x1,… — mirroring VoxelDoc.cells) so a project round-trips as plain JSON;
 * they are re-uploaded to Float32 attributes on render. */
export interface PointCloudDoc {
  readonly kind: "pointcloud";
  name?: string;
  /** Flat XYZ triples in metres; `points.length === 3 · pointCount`. */
  points: number[];
  /** Optional flat per-point RGB in 0..1, same length as `points`. Absent ⇒ a uniform colour. */
  colors?: number[];
  /** Optional flat per-point normals, same length as `points` (needed for cloud→mesh via capture). */
  normals?: number[];
  source: PointCloudSource;
}

/** A persisted document: a parametric CadDocument, a generated MeshDoc, a voxel sculpt, or a dense
 * point cloud. A CadDocument carries no `kind` (back-compat: an absent `kind` ⇒ parametric). */
export type PersistedDoc = CadDocument | MeshDoc | VoxelDoc | PointCloudDoc;

/** Discriminate a persisted document as a mesh document. */
export function isMeshDoc(doc: PersistedDoc): doc is MeshDoc {
  return (doc as Partial<MeshDoc>).kind === "mesh";
}

/** Discriminate any value as a voxel document. */
export function isVoxelDoc(doc: unknown): doc is VoxelDoc {
  return typeof doc === "object" && doc !== null && (doc as Partial<VoxelDoc>).kind === "voxel";
}

/** Discriminate any value as a point-cloud document. */
export function isPointCloudDoc(doc: unknown): doc is PointCloudDoc {
  return typeof doc === "object" && doc !== null && (doc as Partial<PointCloudDoc>).kind === "pointcloud";
}

/** Which kind of sub-entity the 3D viewport selects. */
export type SelectionMode = "face" | "edge" | "vertex" | "body";

/** Top-level editor mode (Fusion-style workspace). Reconfigures the ribbon + side
 * panels to that mode's tools. Transient UI state (not serialized). `simulate` is
 * the authority over the `simulating` flag; `sculpt` hosts the voxel tools (the
 * voxel DOCUMENT itself lives in voxel/voxelStore.ts, like activeMeshDoc for mesh). */
export type Workspace = "design" | "assemble" | "simulate" | "sculpt";

/** A picked B-rep entity, by the kernel's persistent id (SPEC-4 FR-16).
 * `body` selects a whole solid (id = the part's body index, 0 for a single
 * part); face/edge/vertex select a sub-entity by its tagged id. */
export interface Pick {
  readonly kind: "face" | "edge" | "vertex" | "body";
  readonly id: number;
}
