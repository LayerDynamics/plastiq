// @plastiq/recon — public types for the reconstruction client.

/** One reconstruction-chain route attempt (7-L2 observability). */
export interface ReconstructRouteAttempt {
  /** "single_primitive" | "revolution" | "csg" | "cut_cylinder" | "cut_sphere" | "fitted" | "faceted". */
  route: string;
  /** "matched" | "no_match" | "error". */
  outcome: "matched" | "no_match" | "error";
  error?: string | null;
}

export interface ReconstructReport {
  triangles_in: number;
  triangles_used: number;
  faces_built: number;
  planar_faces: number;
  curved_faces?: number;
  freeform_faces?: number;
  faceted_faces?: number;
  surface_deviation?: number;
  fidelity_tol?: number;
  tangent_regions?: number;
  is_solid: boolean;
  is_valid: boolean;
  method: string;
  primitive?: string;
  attempted?: ReconstructRouteAttempt[];
}

export interface ReconstructResult {
  step: string;
  report: ReconstructReport;
}

export interface ReconstructOptions {
  /** Base URL of the reconstruction service. Default http://localhost:8000. */
  baseURL?: string;
  /** Bearer token when the service is deployed with RECONSTRUCT_API_KEY (T36). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPolls?: number;
  delay?: (ms: number) => Promise<void>;
  onState?: (state: string) => void;
  /** Job-id callback, fired once after submit returns — handle for {@link cancelJob} (M4b). */
  onJob?: (id: string) => void;
  method?: "auto" | "fitted" | "faceted";
}

/** Knobs for {@link cancelJob}: the connection subset of {@link ReconstructOptions}. Cancel is a
 * single `DELETE` — the polling knobs don't apply. */
export type ReconstructCancelOptions = Pick<ReconstructOptions, "baseURL" | "apiKey" | "fetchImpl">;
