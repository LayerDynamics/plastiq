// SPEC-11 N11.3 — app-side adapter for the NeRF / photo-capture service (@plastiq/nerf).
//
// The browser client (submit→poll a /train job) lives in the @plastiq/nerf workspace package; this
// thin app module maps its result into the app's own document model and persists it. Posed images +
// a transforms.json are trained server-side (MLX, Apple Silicon) into a surface mesh; the returned
// GLB is wrapped as a MeshDoc — the SAME mesh document the creative mesh-gen produces. `persist`
// returns the new project id; the caller then OPENS it (createMeshProject only persists, it does not
// set the active doc), at which point the existing "Convert to CAD" reconstruct path (mesh → editable
// B-rep) becomes available. The dependency direction is app → @plastiq/nerf (never the reverse).

import {
  cancelJob,
  trainNerf,
  type NerfCancelOptions,
  type NerfOptions,
  type NerfReport,
  type NerfTrainInput,
} from "@plastiq/nerf";

import { useAiStore } from "./aiStore.js";
import type { MeshDoc } from "../store/types.js";

/** Wrap a NeRF result GLB (already base64) as a mesh document. `mode: "photos3d"` records that this
 * mesh came from posed photos via the NeRF/surface-capture service (vs. the creative gen modes). */
export function nerfResultToMeshDoc(glb: string, name = "Captured mesh"): MeshDoc {
  return { kind: "mesh", name, glb, source: { mode: "photos3d", providerId: "nerf" } };
}

export interface CaptureFromPhotosDeps {
  /** Persist a mesh document and return its id (e.g. projectsStore.createMeshProject). */
  persist: (doc: MeshDoc) => Promise<string>;
}

/** Train a surface from posed photos and persist it as a mesh project. Returns the new mesh doc id,
 * the doc, and the training report — the caller can then open it so the "Convert to CAD" path
 * appears. Mirrors the createMesh tool's "produce a MeshDoc → persist" shape.
 *
 * Auth (SPEC-11 §5): a caller-supplied `opts.apiKey` wins; otherwise the persisted `nerfApiKey`
 * setting is threaded into `trainNerf` (sent as `Authorization: Bearer <key>` on every request),
 * matching how the caller sources `nerfBaseURL` from the same settings. */
export async function captureFromPhotos(
  input: NerfTrainInput,
  deps: CaptureFromPhotosDeps,
  opts: NerfOptions = {},
  name = "Captured mesh",
): Promise<{ meshDocId: string; doc: MeshDoc; report: NerfReport }> {
  const apiKey = opts.apiKey ?? useAiStore.getState().settings?.nerfApiKey;
  const result = await trainNerf(input, { ...opts, ...(apiKey ? { apiKey } : {}) });
  const doc = nerfResultToMeshDoc(result.glb, name);
  const meshDocId = await deps.persist(doc);
  return { meshDocId, doc, report: result.report };
}

/** Cancel a capture's training job server-side (`DELETE /jobs/{id}`, SPEC-11 §5) — the counterpart
 * to {@link captureFromPhotos} for the panel's Cancel: aborting the client-side polling alone
 * would leave the server training to completion for nobody. The job id comes from the capture's
 * `opts.onJob` callback. Resolves on 204 and on 404 (already gone). Auth is threaded exactly like
 * the capture path: a caller-supplied `opts.apiKey` wins; otherwise the persisted `nerfApiKey`
 * setting rides as `Authorization: Bearer <key>`. */
export async function cancelCapture(jobId: string, opts: NerfCancelOptions = {}): Promise<void> {
  const apiKey = opts.apiKey ?? useAiStore.getState().settings?.nerfApiKey;
  await cancelJob(jobId, { ...opts, ...(apiKey ? { apiKey } : {}) });
}
