// @plastiq/ml — shared job-client types for the five domain ML services.
//
// Each domain package (capture / nerf / nurbs / photogrammetry / recon) owns its
// request/response payloads. These types only describe the common connection +
// poll + cancel knobs so clients do not drift on cancel/onJob/auth shape (M10).

/** In-flight / terminal states returned by GET /jobs/{id}/status across services. */
export type JobState = "queued" | "running" | "completed" | "failed" | (string & {});

/**
 * Connection + poll knobs shared by every submit→poll client.
 * Domain packages extend this with service-specific fields (method, fidelityTol, …).
 */
export interface JobClientOptions {
  /** Service base URL (each domain has its own default localhost port). */
  baseURL?: string;
  /** Bearer token when the service is deployed with `*_API_KEY` (open when unset). */
  apiKey?: string;
  /** Injectable fetch (tests pass a fake; defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Per-poll delay (constant interval; tests inject an instant resolver). */
  delay?: (ms: number) => Promise<void>;
  /** Job-state callback for UI progress. */
  onState?: (state: string) => void;
  /**
   * Job-id callback, fired once after submit returns — the handle for
   * {@link cancelServiceJob} / domain `cancelJob` while polling continues.
   */
  onJob?: (id: string) => void;
}

/** Knobs for DELETE /jobs/{id}. Polling fields do not apply. */
export type JobCancelOptions = Pick<JobClientOptions, "baseURL" | "apiKey" | "fetchImpl" | "signal">;
