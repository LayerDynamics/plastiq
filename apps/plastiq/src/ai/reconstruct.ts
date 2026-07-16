// SPEC-7 R6.6 — app adapter for mesh→B-rep reconstruction (@plastiq/recon + CadDocument seam).
//
// Heavy submit→poll client lives in `@plastiq/recon` (T32); this module re-exports it and wraps
// STEP as a parametric CadDocument for loadDocument. Settings thread reconstructBaseURL +
// reconstructApiKey (T36) unless the caller overrides opts.

import {
  cancelJob,
  reconstructMesh as reconClient,
  type ReconstructCancelOptions,
  type ReconstructOptions,
  type ReconstructReport,
  type ReconstructResult,
  type ReconstructRouteAttempt,
} from "@plastiq/recon";

import { useAiStore } from "./aiStore.js";
import type { CadDocument } from "../store/types.js";

export type {
  ReconstructCancelOptions,
  ReconstructOptions,
  ReconstructReport,
  ReconstructResult,
  ReconstructRouteAttempt,
};

/** Resolve connection knobs from settings unless the caller overrides them. */
function withReconstructSettings<T extends ReconstructCancelOptions>(opts: T): T {
  const settings = useAiStore.getState().settings;
  const baseURL = opts.baseURL ?? settings?.reconstructBaseURL;
  const apiKey = opts.apiKey ?? settings?.reconstructApiKey;
  return {
    ...opts,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Reconstruct a mesh (base64 GLB) into a B-rep STEP. Caller opts override settings.
 *
 * `opts.onJob` yields the job id so the panel can cancel it mid-poll via {@link cancelReconstruct}. */
export async function reconstructMesh(
  glbBase64: string,
  opts: ReconstructOptions = {},
): Promise<ReconstructResult> {
  return reconClient(glbBase64, withReconstructSettings(opts));
}

/** Cancel a reconstruction job server-side (`DELETE /jobs/{id}`, M4b) — the counterpart to
 * {@link reconstructMesh} for the panel's Cancel: aborting the client-side polling alone would
 * leave the server reconstructing for nobody. The job id comes from `opts.onJob`. Resolves on
 * 204 and on 404 (already gone). Auth/base URL are threaded exactly like the reconstruct path. */
export async function cancelReconstruct(
  jobId: string,
  opts: ReconstructCancelOptions = {},
): Promise<void> {
  await cancelJob(jobId, withReconstructSettings(opts));
}

/** Wrap reconstructed STEP text as a parametric document (one importStep feature) so it
 * rebuilds via the kernel's importStep path into an editable B-rep part. */
export function stepToImportDocument(step: string, name = "Reconstructed mesh"): CadDocument {
  return { features: [{ id: "f1", type: "importStep", name, data: { step } }], params: {} };
}
