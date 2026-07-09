// @plastiq/nerf — public types for the NeRF/surface-capture client.
//
// These are intentionally decoupled from the app's document model: the package returns a base64
// GLB + a report, and the *app* (apps/plastiq) maps that into its own MeshDoc. The dependency
// direction is app → @plastiq/nerf, never the reverse, so the package stays embeddable anywhere.

/** Which MLX model the service trains to produce the surface (SPEC-11). */
export type NerfMethod = "nerf" | "neus";

/** Position encoding of the radiance NeRF field (`method: "nerf"`): classic sinusoidal frequency
 * bands, or the instant-NGP multiresolution hash grid. */
export type NerfEncoding = "frequency" | "hashgrid";

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
  /** Position encoding for the radiance field — `method: "nerf"` only. `"frequency"` (classic NeRF
   * sinusoidal, the service default) or `"hashgrid"` (instant-NGP multiresolution hash grid — fits
   * sharp detail faster). The `"neus"` SDF trunk consumes raw coordinates by design (its geometric
   * init requires them), so the service rejects `"hashgrid"` with `"neus"` (422) rather than
   * silently ignoring it. Sent as `encoding` on the wire. */
  encoding?: NerfEncoding;
  /** Fine PDF (importance/hierarchical) samples per ray: a coarse pass seeds a second pass
   * concentrated on the surface. Supported by both methods; 0/omitted ⇒ coarse-only (the service
   * default). Sent as `importance_samples` on the wire (service cap: 128). */
  importanceSamples?: number;
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
  /** Position encoding the job actually trained with (additive — absent from older services). */
  encoding?: NerfEncoding;
  /** Fine PDF samples per ray the job actually trained with; 0 = coarse-only (additive — absent
   * from older services). */
  importanceSamples?: number;
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
  /** API key for a key-protected deployment (the service's `NERF_API_KEY`) — sent as
   * `Authorization: Bearer <key>` on every request. Absent ⇒ no auth header (open dev default). */
  apiKey?: string;
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
  /** Job-id callback, fired once (right after the submit returns, before the first poll) — the
   * handle a caller needs to cancel the in-flight job server-side via {@link cancelJob} while
   * this same call keeps polling. */
  onJob?: (id: string) => void;
}

/** Knobs for {@link cancelJob}: the connection subset of {@link NerfOptions}. Cancel is a single
 * `DELETE` — the polling knobs don't apply. */
export type NerfCancelOptions = Pick<NerfOptions, "baseURL" | "apiKey" | "fetchImpl">;
