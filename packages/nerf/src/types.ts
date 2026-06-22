// @plastiq/nerf — public types for the NeRF/surface-capture client.
//
// These are intentionally decoupled from the app's document model: the package returns a base64
// GLB + a report, and the *app* (apps/plastiq) maps that into its own MeshDoc. The dependency
// direction is app → @plastiq/nerf, never the reverse, so the package stays embeddable anywhere.

/** Which MLX model the service trains to produce the surface (SPEC-11). */
export type NerfMethod = "nerf" | "neus";

/** The inputs to a training job: camera poses + the views they describe.
 *
 * `transformsJson` is the nerfstudio/instant-ngp `transforms.json` schema (camera intrinsics +
 * per-frame `transform_matrix` poses). Producing it from raw photos is COLMAP/SfM's job — out of
 * scope for this service, which ingests the already-posed result (SPEC-11). */
export interface NerfTrainInput {
  /** `transforms.json` content — a JSON string or a parsed object (the client stringifies it). */
  transformsJson: string | Record<string, unknown>;
  /** The posed views as base64-encoded PNG/JPEG, parallel to the frames in `transformsJson`. */
  images: string[];
  /** Training iterations (default: the service's own default). */
  iters?: number;
  /** Density NeRF (`"nerf"`) or NeuS/VolSDF surface field (`"neus"`, sharper meshes). */
  method?: NerfMethod;
  /** Marching-cubes grid resolution for the exported mesh. */
  gridRes?: number;
}

/** The training/extraction summary returned alongside the mesh. */
export interface NerfReport {
  /** The model that produced the mesh. */
  method: NerfMethod;
  /** Training iterations actually run. */
  iters: number;
  /** Final held-out PSNR in dB — the training-quality signal (higher = sharper fit). */
  psnr: number;
  /** Marching-cubes mesh size. */
  vertices: number;
  faces: number;
}

/** A completed job: the reconstructed surface as a base64 GLB + its report. The GLB feeds the
 * app's `MeshDoc` → reconstruct (mesh → B-rep) path, exactly like the capture service's output. */
export interface NerfResult {
  /** The reconstructed surface as a base64-encoded GLB. */
  glb: string;
  report: NerfReport;
}

/** Knobs for {@link trainNerf}: where the service lives, how to talk to it, and how to poll. */
export interface NerfOptions {
  /** Base URL of the NeRF service. Default `http://localhost:8002` (the documented dev port). */
  baseURL?: string;
  /** Injectable fetch (tests pass a fake; defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Max poll attempts before timing out (default 600 ≈ 20 min at 2s — training is slow). */
  maxPolls?: number;
  /** Per-poll delay (a constant `pollIntervalMs`, not a backoff; tests inject an instant resolver). */
  delay?: (ms: number) => Promise<void>;
  /** Job-state callback for UI progress (`"queued" | "running" | …`). */
  onState?: (state: string) => void;
}
