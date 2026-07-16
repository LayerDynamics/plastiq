// @plastiq/capture — public types for the capture/completion client.
//
// These are intentionally decoupled from the app's document model: the package returns a base64
// GLB + a report, and the *app* (apps/plastiq) maps that into its own MeshDoc. The dependency
// direction is app → @plastiq/capture, never the reverse, so the package stays embeddable anywhere.
//
// Optional bearer auth: when CAPTURE_API_KEY is set on the server, pass `apiKey` so
// Authorization: Bearer is sent on mutating requests (T36; open when unset).

/** The server's minimum point count — `POST /capture` and `POST /complete` both 400 below this
 * (services/capture/app/main.py: "need at least 16 points"). Exported so callers can pre-check
 * before serializing a large request body. */
export const MIN_POINTS = 16;

/** Inputs to a surface-reconstruction job (`POST /capture`): an ORIENTED point cloud.
 *
 * The server fits an MLX neural SDF to the points (surface + normal + eikonal losses) and
 * marching-cubes the zero level-set into a watertight mesh (SPEC-10 §capture). Producing the
 * oriented cloud from photos is COLMAP's / a depth sensor's job, upstream of this client. */
export interface CaptureInput {
  /** Nx3 positions. Every value must be finite; the server 400s otherwise. */
  points: number[][];
  /** Nx3 unit normals, parallel to `points` (same length — the server 400s on a mismatch). */
  normals: number[][];
  /** SDF fit iterations (default: the server's own default, 600). */
  iters?: number;
  /** Marching-cubes grid resolution for the exported mesh (server default 64). */
  gridRes?: number;
}

/** Inputs to a shape-completion job (`POST /complete`): a PARTIAL point cloud (a scan with
 * holes), completed into a full mesh by the conditional occupancy network (SPEC-10 §completion).
 * No normals — the completion net conditions on positions only. */
export interface CompleteInput {
  /** Nx3 positions of the partial scan. Every value must be finite. */
  points: number[][];
  /** Marching-cubes grid resolution for the exported mesh (server default 48). */
  gridRes?: number;
}

/** The mesh-size summary returned alongside the GLB (`GET /jobs/{id}/result`). */
export interface CaptureReport {
  /** Marching-cubes mesh size. */
  vertices: number;
  faces: number;
  /**
   * Present on `/complete` results when the server used the synthetic demo completer
   * (`CAPTURE_COMPLETION_CHECKPOINT` unset). Callers should surface this in the UI (T24/M2).
   */
  demoWeights?: boolean;
}

/** A completed job: the reconstructed/completed surface as a base64 GLB + its report. The GLB
 * feeds the app's `MeshDoc` → reconstruct (mesh → B-rep) path, exactly like the NeRF service's
 * output. */
export interface CaptureResult {
  /** The watertight mesh as a base64-encoded GLB. */
  glb: string;
  report: CaptureReport;
}

/** Knobs for {@link capturePointCloud} / {@link completePartialScan}: where the service lives,
 * how to talk to it, and how to poll. */
export interface CaptureOptions {
  /** Base URL of the capture service. Default `http://localhost:8001` (the documented dev port:
   * reconstruct=8000, capture=8001, nerf=8002). */
  baseURL?: string;
  /** Bearer token when the service is deployed with CAPTURE_API_KEY (T36). */
  apiKey?: string;
  /** Injectable fetch (tests pass a fake; defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Poll interval in ms (default 1000 — capture jobs run seconds-to-minutes, not the
   * minutes-to-hours of NeRF training). */
  pollIntervalMs?: number;
  /** Max poll attempts before timing out (default 600 ≈ 10 min at 1s). */
  maxPolls?: number;
  /** Per-poll delay (a constant `pollIntervalMs`, not a backoff; tests inject an instant resolver). */
  delay?: (ms: number) => Promise<void>;
  /** Job-state callback for UI progress (`"queued" | "running" | "completed" | "failed"`). */
  onState?: (state: string) => void;
  /** Job-id callback, fired once after submit returns — handle for {@link cancelJob} (M4). */
  onJob?: (id: string) => void;
}
