// CAD Studio document + selection types (SPEC-5 FR-2).
import type { AssemblyModel } from "../assembly/model.js";
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

/** How a mesh document was generated (the creative path; SPEC-6 R4). */
export interface MeshSource {
  mode: "text2img3d" | "img3d" | "text3d";
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
  source: MeshSource;
}

/** A persisted document: a parametric CadDocument or a generated MeshDoc. A
 * CadDocument carries no `kind` (back-compat: an absent `kind` ⇒ parametric). */
export type PersistedDoc = CadDocument | MeshDoc;

/** Discriminate a persisted document as a mesh document. */
export function isMeshDoc(doc: PersistedDoc): doc is MeshDoc {
  return (doc as Partial<MeshDoc>).kind === "mesh";
}

/** Which kind of sub-entity the 3D viewport selects. */
export type SelectionMode = "face" | "edge" | "vertex" | "body";

/** Top-level editor mode (Fusion-style workspace). Reconfigures the ribbon + side
 * panels to that mode's tools. Transient UI state (not serialized). `simulate` is
 * the authority over the `simulating` flag. */
export type Workspace = "design" | "assemble" | "simulate";

/** A picked B-rep entity, by the kernel's persistent id (SPEC-4 FR-16).
 * `body` selects a whole solid (id = the part's body index, 0 for a single
 * part); face/edge/vertex select a sub-entity by its tagged id. */
export interface Pick {
  readonly kind: "face" | "edge" | "vertex" | "body";
  readonly id: number;
}
