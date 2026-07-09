// SPEC-13 P11.2 — app-side adapter for the SfM+MVS photogrammetry service (@plastiq/photogrammetry).
//
// The browser client (submit→poll a /solve job) lives in the @plastiq/photogrammetry workspace
// package; this thin app module threads the persisted service settings into it and maps its result
// into the app's two existing legs. Unposed photos are solved server-side (SfM + MLX plane-sweep MVS,
// Apple Silicon) into camera poses (a transforms.json) + a dense oriented point cloud, which feed:
//   (a) the NeRF leg — transforms.json + undistorted images prefill the NerfCaptureSection (→ /train
//       → MeshDoc → Convert-to-CAD), and
//   (b) the capture leg — the dense cloud is parsed to {points, normals} and reconstructed to a
//       watertight MeshDoc via the SAME capture path meshFromPointCloud uses (→ Convert-to-CAD).
// The dependency direction is app → @plastiq/photogrammetry (never the reverse).
//
// Auth (SPEC-13 §6.1, the SPEC-11 §5 model): a caller-supplied `opts.apiKey`/`opts.baseURL` wins;
// otherwise the persisted `photogrammetryApiKey` / `photogrammetryBaseURL` settings are threaded into
// the client (the key rides as `Authorization: Bearer <key>` on every request).

import { parsePointCloud, type CaptureInput, type CaptureOptions } from "@plastiq/capture";
import {
  cancelJob,
  solvePhotos,
  type PhotogrammetryCancelOptions,
  type PhotogrammetryOptions,
  type PhotogrammetryResult,
  type PhotogrammetrySolveInput,
} from "@plastiq/photogrammetry";

import { useAiStore } from "./aiStore.js";
import { meshFromPointCloud, type CaptureScanDeps } from "./capture.js";
import type { MeshDoc } from "../store/types.js";

/** Merge the persisted photogrammetry service settings under any caller-supplied overrides. */
function withServiceSettings<T extends { apiKey?: string; baseURL?: string }>(opts: T): T {
  const settings = useAiStore.getState().settings;
  const apiKey = opts.apiKey ?? settings?.photogrammetryApiKey;
  const baseURL = opts.baseURL ?? settings?.photogrammetryBaseURL;
  return {
    ...opts,
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
  };
}

/** Solve unposed photos → poses + clouds, threading the persisted service settings. The result's
 * `transformsJson`/`imagesUndistorted` feed the NeRF leg and `densePly` feeds the capture leg (see
 * {@link denseCloudToMeshDoc}). `opts.onJob` yields the job id so the panel can cancel it mid-poll. */
export async function solvePhotogrammetry(
  input: PhotogrammetrySolveInput,
  opts: PhotogrammetryOptions = {},
): Promise<PhotogrammetryResult> {
  return solvePhotos(input, withServiceSettings(opts));
}

/** Cancel an in-flight solve server-side (`DELETE /jobs/{id}`) — the counterpart to
 * {@link solvePhotogrammetry} for the panel's Cancel; aborting the client-side polling alone would
 * leave the server solving to completion for nobody. The job id comes from `opts.onJob`. Resolves on
 * 204 and on 404 (already gone). Settings are threaded exactly like the solve path. */
export async function cancelPhotogrammetry(
  jobId: string,
  opts: PhotogrammetryCancelOptions = {},
): Promise<void> {
  await cancelJob(jobId, withServiceSettings(opts));
}

/** Parse a base64 dense-cloud PLY (`x y z nx ny nz r g b`, §6.3) into the capture service's
 * `{points, normals}` input. Throws when the cloud carries no normals (a `/capture` requirement) —
 * which only happens for a malformed/sparse-only PLY, never for a real dense result. */
export function parseDenseCloud(densePly: string): CaptureInput {
  const text = atob(densePly);
  const parsed = parsePointCloud("dense.ply", text);
  if (!parsed.normals) {
    throw new Error(
      "photogrammetry dense cloud has no normals — it cannot be reconstructed via the capture service",
    );
  }
  return { points: parsed.points, normals: parsed.normals };
}

/** Hand-off (b): reconstruct the dense oriented cloud into a watertight MeshDoc via the capture
 * service (`POST /capture`), reusing {@link meshFromPointCloud}. Returns the new mesh doc id + report;
 * the caller then OPENS it so the "Convert to CAD" path appears — the same terminus as the NeRF leg. */
export async function denseCloudToMeshDoc(
  densePly: string,
  deps: CaptureScanDeps,
  opts: CaptureOptions = {},
  name = "Photogrammetry mesh",
): Promise<{ meshDocId: string; doc: MeshDoc; report: unknown }> {
  const input = parseDenseCloud(densePly);
  return meshFromPointCloud(input, deps, opts, name);
}
