// @plastiq/photogrammetry — public types for the SfM+MVS photogrammetry client.
//
// These are intentionally decoupled from the app's document model: the package returns a
// transforms.json string + base64 PLY clouds + a report, and the *app* (apps/plastiq) maps that
// into its own NerfCaptureSection / MeshDoc hand-offs. The dependency direction is
// app → @plastiq/photogrammetry, never the reverse, so the package stays embeddable anywhere.

/** Pair-generation schedule for descriptor matching (SPEC-13 §6.1): all-pairs, or a sequential
 * window over an ordered photo set. */
export type PhotogrammetryMatching = "exhaustive" | "sequential";

/** The inputs to a solve: unposed photos (no `transforms.json` — producing it is this service's
 * whole job). `images` are base64-encoded JPEG/PNG; the optional `names` are their parallel
 * filenames (the service names `frame_%05d.jpg` when absent), used as the emitted
 * `frames[].file_path` basenames so the panel can pair the undistorted images back by name. */
export interface PhotogrammetrySolveInput {
  /** The photos as base64-encoded JPEG/PNG (3..`PHOTOGRAMMETRY_MAX_IMAGES`, default 300). */
  images: string[];
  /** Parallel filenames for `images` (same length). Sent as `names`; server-defaulted when absent. */
  names?: string[];
  /** Pair schedule — `"exhaustive"` (default) or `"sequential"` (ordered sets). Sent as `matching`. */
  matching?: PhotogrammetryMatching;
  /** Run dense MVS (default `true`): omit/false ⇒ sparse-only, `densePly` comes back `null`. */
  dense?: boolean;
  /** Undistort registered frames + zero the emitted distortion (default `true`, D-6). `false` keeps
   * the calibrated `k1,k2,p1,p2` on the wire and omits `imagesUndistorted`. Sent as `undistort`. */
  undistort?: boolean;
  /** Per-image feature cap (default 4096, 512..16384). Sent as `max_features` on the wire. */
  maxFeatures?: number;
  /** RANSAC seed for a deterministic solve (default 0, D-10). Sent as `seed`. */
  seed?: number;
  /**
   * Longest-side pixel cap for **sparse** SfM only (256..4096). When set and an upload is larger,
   * the service downscales for registration and densifies MVS at full native resolution
   * (`dense_images`). Recommended ~640 for robustness (pixel-absolute RANSAC thresholds).
   * Sent as `sparse_max_dim`. Omit ⇒ both stages run at native resolution.
   */
  sparseMaxDim?: number;
}

/** The self-calibrated shared camera (one device per job, §6.2): OpenCV pinhole + Brown-Conrady. */
export interface PhotogrammetryCamera {
  model: string;
  w: number;
  h: number;
  fl_x: number;
  fl_y: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
}

/** The normalization similarity baked into the emitted poses/points (D-5): the forward map
 * (solver world → normalized/emitted world) as a 3×4 `applied_transform` + uniform `scale`. */
export interface PhotogrammetryNormalization {
  applied_transform: number[][];
  scale: number;
}

/** The solve-quality summary (SPEC-13 FR-8), carried alongside the geometry so the UX can show
 * registration honesty. Passed through in the service's snake_case wire form. */
export interface PhotogrammetryReport {
  images_total: number;
  images_registered: number;
  /** Images that failed to register — reported by name, never silently dropped (FR-2). */
  unregistered_names: string[];
  sparse_points: number;
  dense_points: number;
  mean_reprojection_error_px: number;
  mean_track_length: number;
  camera: PhotogrammetryCamera;
  normalization: PhotogrammetryNormalization;
  matching: PhotogrammetryMatching;
  seed: number;
  dense: boolean;
  undistorted: boolean;
}

/** A completed solve: camera poses (`transformsJson`, nerfstudio/OpenGL convention) + a sparse and
 * an optional dense oriented point cloud (base64 ASCII PLY) + the report. `transformsJson` +
 * `imagesUndistorted` feed `services/nerf` `/train`; `densePly` feeds `services/capture` `/capture`
 * via the `@plastiq/capture` PLY parser. */
export interface PhotogrammetryResult {
  /** `transforms.json` content as a string (§6.2). */
  transformsJson: string;
  /** Undistorted frames parallel to `frames[]` when `undistort:true`; `null` otherwise (D-6). */
  imagesUndistorted: string[] | null;
  /** Sparse SfM cloud as a base64 ASCII PLY (`x y z r g b`) — always present. */
  sparsePly: string;
  /** Dense oriented cloud as a base64 ASCII PLY (`x y z nx ny nz r g b`); `null` when `dense:false`
   * or fusion produced no points (§7). */
  densePly: string | null;
  report: PhotogrammetryReport;
}

/** Knobs for {@link solvePhotos}: where the service lives, how to talk to it, and how to poll. */
export interface PhotogrammetryOptions {
  /** Base URL of the photogrammetry service. Default `http://localhost:8004` (the documented dev
   * port: reconstruct=8000, capture=8001, nerf=8002, nurbs=8003, photogrammetry=8004). */
  baseURL?: string;
  /** API key for a key-protected deployment (`PHOTOGRAMMETRY_API_KEY`) — sent as
   * `Authorization: Bearer <key>` on every request. Absent ⇒ no auth header (open dev default). */
  apiKey?: string;
  /** Injectable fetch (tests pass a fake; defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Max poll attempts before timing out (default 600 ≈ 20 min at 2s — a full solve is minutes). */
  maxPolls?: number;
  /** Per-poll delay (a constant `pollIntervalMs`, not a backoff; tests inject an instant resolver). */
  delay?: (ms: number) => Promise<void>;
  /** Job-id callback, fired once (right after the submit returns, before the first poll) — the
   * handle a caller needs to cancel the in-flight job server-side via {@link cancelJob} while this
   * same call keeps polling. */
  onJob?: (id: string) => void;
}

/** Knobs for {@link cancelJob}: the connection subset of {@link PhotogrammetryOptions}. Cancel is a
 * single `DELETE` — the polling knobs don't apply. */
export type PhotogrammetryCancelOptions = Pick<PhotogrammetryOptions, "baseURL" | "apiKey" | "fetchImpl">;
