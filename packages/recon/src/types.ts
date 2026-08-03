// @plastiq/recon — public types for the reconstruction client.

import type { JobCancelOptions, JobClientOptions } from "@plastiq/ml";

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

export interface ReconstructOptions extends JobClientOptions {
  method?: "auto" | "fitted" | "faceted";
}

/** Knobs for {@link cancelJob}: the connection subset of {@link ReconstructOptions}. Cancel is a
 * single `DELETE` — the polling knobs don't apply. */
export type ReconstructCancelOptions = JobCancelOptions;
