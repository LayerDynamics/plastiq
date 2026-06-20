// SPEC-6 R4.3 — pluggable image-gen + 3D-gen provider contracts (spec §6.5,
// FR-15…FR-18a, decisions 6/15).
//
// The creative path turns a prompt and/or image into a GLB mesh via cloud services.
// Honest constraint (Risk R-1): these need network + an account, so the creative path
// is explicitly NOT no-server. Providers are multi-selectable with NO hard default
// (decision 6); the user picks one per job and every job is paid (FR-18a gate). Two
// interfaces:
//   • ImageGenProvider — text → image (the text→image stage of text→image→3D).
//   • MeshGenProvider  — image|text → 3D GLB, via submit→poll (NO webhook: Plastiq has
//     no server, and fal supports client polling; a webhook-only provider would need
//     the proxy — documented, opt-in).

/** A generated or user-attached image, base64 (no data-URL prefix). */
export interface GenImage {
  /** MIME type, e.g. "image/png" | "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes. */
  data: string;
}

/** Generates an image from a text prompt (the text→image stage). A paid call. */
export interface ImageGenProvider {
  /** Stable id, e.g. "fal:flux/schnell". */
  readonly id: string;
  /** Human-facing label for the picker. */
  readonly label: string;
  generate(prompt: string, signal?: AbortSignal): Promise<GenImage>;
}

/** The three creative input modes (decision 15). */
export type MeshGenMode = "text2img3d" | "img3d" | "text3d";

/** Input to a single 3D-generation job. `prompt` drives text→3D; `image` drives
 * image→3D (the image is either user-attached or produced by an ImageGenProvider). */
export interface MeshGenRequest {
  prompt?: string;
  image?: GenImage;
  /** Provider-specific quality/speed hint (opaque to the pipeline). */
  quality?: string;
}

/** An opaque handle to a submitted 3D-gen job; poll it for status. */
export interface MeshGenJob {
  readonly id: string;
}

/** A poll result. `succeeded` carries the URL of the produced GLB to fetch. */
export type MeshGenStatus =
  | { state: "pending" }
  | { state: "running"; progress?: number }
  | { state: "succeeded"; glbUrl: string }
  | { state: "failed"; error: string };

/** A pluggable 3D-generation provider — submit a paid job, then poll (no webhook). */
export interface MeshGenProvider {
  /** Stable id, e.g. "fal:tripo" | "fal:meshy" | "fal:hunyuan3d". */
  readonly id: string;
  /** Human-facing label for the picker. */
  readonly label: string;
  /** Which input modes this provider can serve directly. */
  readonly supports: { text3d: boolean; img3d: boolean };
  /** Submit a paid generation job; returns a handle to poll. */
  submit(req: MeshGenRequest, signal?: AbortSignal): Promise<MeshGenJob>;
  /** Poll a submitted job for its current status. */
  poll(job: MeshGenJob, signal?: AbortSignal): Promise<MeshGenStatus>;
}
