// SPEC-10 (browser client, 2026-07-03) — app-side adapter for the point-cloud capture/completion
// service (@plastiq/capture).
//
// The browser client (submit→poll a /capture or /complete job) lives in the @plastiq/capture
// workspace package; this thin app module maps its result into the app's own document model and
// persists it. An oriented point cloud (or a partial scan) is fitted server-side (MLX, Apple
// Silicon) into a watertight mesh; the returned GLB is wrapped as a MeshDoc — the SAME mesh
// document the creative mesh-gen and NeRF capture produce. `persist` returns the new project id;
// the caller then OPENS it (createMeshProject only persists, it does not set the active doc), at
// which point the existing "Convert to CAD" reconstruct path (mesh → editable B-rep) becomes
// available. The dependency direction is app → @plastiq/capture (never the reverse).
// Optional CAPTURE_API_KEY is threaded from settings.captureApiKey (T36).

import {
  cancelJob,
  capturePointCloud,
  completePartialScan,
  type CaptureInput,
  type CaptureOptions,
  type CaptureReport,
  type CompleteInput,
} from "@plastiq/capture";

import { useAiStore } from "./aiStore.js";
import type { MeshDoc } from "../store/types.js";

/** Wrap a capture-service GLB (already base64) as a mesh document. `mode: "photos3d"` is the
 * document model's real-world-capture family (MeshSource has no dedicated point-cloud mode);
 * the providerId distinguishes the scan paths — "capture" for /capture, "capture:complete" for
 * /complete — from the NeRF path's "nerf". */
export function captureResultToMeshDoc(glb: string, providerId: "capture" | "capture:complete", name = "Scanned mesh"): MeshDoc {
  return { kind: "mesh", name, glb, source: { mode: "photos3d", providerId } };
}

export interface CaptureScanDeps {
  /** Persist a mesh document and return its id (e.g. projectsStore.createMeshProject). */
  persist: (doc: MeshDoc) => Promise<string>;
}

/** Reconstruct a watertight mesh from an ORIENTED point cloud (`POST /capture`) and persist it as
 * a mesh project. Returns the new mesh doc id, the doc, and the mesh-size report — the caller can
 * then open it so the "Convert to CAD" path appears. Mirrors nerf.ts's captureFromPhotos shape. */
function withCaptureSettings(opts: CaptureOptions): CaptureOptions {
  const settings = useAiStore.getState().settings;
  const baseURL = opts.baseURL ?? settings?.captureBaseURL;
  const apiKey = opts.apiKey ?? settings?.captureApiKey;
  return { ...opts, ...(baseURL ? { baseURL } : {}), ...(apiKey ? { apiKey } : {}) };
}

export async function meshFromPointCloud(
  input: CaptureInput,
  deps: CaptureScanDeps,
  opts: CaptureOptions = {},
  name = "Scanned mesh",
): Promise<{ meshDocId: string; doc: MeshDoc; report: CaptureReport }> {
  const result = await capturePointCloud(input, withCaptureSettings(opts));
  const doc = captureResultToMeshDoc(result.glb, "capture", name);
  const meshDocId = await deps.persist(doc);
  return { meshDocId, doc, report: result.report };
}

/** Complete a PARTIAL scan (`POST /complete`, the M8 shape-completion path) into a full mesh and
 * persist it as a mesh project. Same return shape as {@link meshFromPointCloud}. */
export async function meshFromPartialScan(
  input: CompleteInput,
  deps: CaptureScanDeps,
  opts: CaptureOptions = {},
  name = "Completed scan",
): Promise<{ meshDocId: string; doc: MeshDoc; report: CaptureReport }> {
  const result = await completePartialScan(input, withCaptureSettings(opts));
  const doc = captureResultToMeshDoc(result.glb, "capture:complete", name);
  const meshDocId = await deps.persist(doc);
  return { meshDocId, doc, report: result.report };
}

/** Server-side cancel (`DELETE /jobs/{id}`) — force-stops the capture worker when in flight. */
export async function cancelCaptureJob(
  jobId: string,
  opts: Pick<CaptureOptions, "baseURL" | "apiKey" | "fetchImpl" | "signal"> = {},
): Promise<void> {
  await cancelJob(jobId, withCaptureSettings(opts));
}
