// @plastiq/photogrammetry — client for the SfM+MVS photogrammetry service (services/photogrammetry).
//
// Submits unposed photos to the self-hosted backend and polls for the solved result: a
// transforms.json (nerfstudio/OpenGL convention) + a sparse cloud + an optional dense oriented
// point cloud. The submit→poll shape mirrors the capture/nerf/reconstruct services exactly — POST a
// job, GET /jobs/{id}/status until "completed", then GET /jobs/{id}/result (SPEC-13 §6.1) — so the
// browser reuses the same polling machinery. The transforms.json + undistorted images feed
// services/nerf; the dense PLY feeds services/capture (via @plastiq/capture's parser). Self-hosted,
// reached by base URL.

import type {
  PhotogrammetryCancelOptions,
  PhotogrammetryOptions,
  PhotogrammetryReport,
  PhotogrammetryResult,
  PhotogrammetrySolveInput,
} from "./types.js";

/** The documented dev port for services/photogrammetry (reconstruct=8000, capture=8001, nerf=8002,
 * nurbs=8003, photogrammetry=8004). */
const DEFAULT_BASE_URL = "http://localhost:8004";

/** Shape of `GET /jobs/{id}/result` on the photogrammetry service (snake_case wire form, §6.1).
 * `images_undistorted` and `dense_ply_base64` are `null` when undistort/dense are off (D-6/§7). */
interface PhotogrammetryResultWire {
  transforms_json: string;
  images_undistorted: string[] | null;
  sparse_ply_base64: string;
  dense_ply_base64: string | null;
  report: PhotogrammetryReport;
}

async function httpError(res: Response, what: string): Promise<string> {
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b.detail ?? "")
    .catch(() => "");
  return `photogrammetry ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

/** Solve camera poses + point clouds from unposed photos (submit → poll → result, SPEC-13 §6.1).
 *
 * Throws on submit/status/result HTTP errors, on a `failed` job, on an aborted signal, and on poll
 * timeout. The returned `transformsJson` + `imagesUndistorted` feed `services/nerf` `/train`, and
 * `densePly` feeds `services/capture` `/capture` via the `@plastiq/capture` PLY parser. When
 * `opts.apiKey` is set it is sent as `Authorization: Bearer <key>` on EVERY request — the service
 * enforces it on `POST /solve` (and `DELETE /jobs/{id}`) when deployed with `PHOTOGRAMMETRY_API_KEY`;
 * sending it uniformly keeps the client correct if the read endpoints are ever guarded too (§6.1).
 *
 * `opts.onJob` fires with the job id right after the submit returns — the handle for cancelling the
 * job server-side ({@link cancelJob}) while this call keeps polling. */
export async function solvePhotos(
  input: PhotogrammetrySolveInput,
  opts: PhotogrammetryOptions = {},
): Promise<PhotogrammetryResult> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("photogrammetry: no fetch implementation available");
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? 2000;
  const maxPolls = opts.maxPolls ?? 600;
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  /** Shared init for the GET polls: bearer auth (if configured) + abort signal (if provided). */
  const getInit: RequestInit = {
    ...(opts.apiKey ? { headers: auth } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const body: Record<string, unknown> = { images: input.images };
  if (input.names !== undefined) body.names = input.names;
  if (input.matching !== undefined) body.matching = input.matching;
  if (input.dense !== undefined) body.dense = input.dense;
  if (input.undistort !== undefined) body.undistort = input.undistort;
  if (input.maxFeatures !== undefined) body.max_features = input.maxFeatures;
  if (input.seed !== undefined) body.seed = input.seed;

  const submitRes = await f(`${base}/solve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!submitRes.ok) throw new Error(await httpError(submitRes, "submit"));
  const submitted = (await submitRes.json()) as { id?: string };
  if (!submitted.id) throw new Error("photogrammetry: submit returned no job id");
  const id = submitted.id;
  opts.onJob?.(id);

  for (let i = 0; i < maxPolls; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const statusRes = await f(`${base}/jobs/${id}/status`, getInit);
    if (!statusRes.ok) throw new Error(await httpError(statusRes, "status"));
    const status = (await statusRes.json()) as { state?: string; error?: string };
    if (status.state === "completed") {
      const resultRes = await f(`${base}/jobs/${id}/result`, getInit);
      if (!resultRes.ok) throw new Error(await httpError(resultRes, "result"));
      const wire = (await resultRes.json()) as PhotogrammetryResultWire;
      return {
        transformsJson: wire.transforms_json,
        imagesUndistorted: wire.images_undistorted,
        sparsePly: wire.sparse_ply_base64,
        densePly: wire.dense_ply_base64,
        report: wire.report,
      };
    }
    if (status.state === "failed") {
      throw new Error(`photogrammetry solve failed: ${status.error ?? "unknown error"}`);
    }
    await delay(interval);
  }
  throw new Error(`photogrammetry solve timed out after ${maxPolls} polls`);
}

/** Cancel/clean up a solve job server-side: `DELETE {baseURL}/jobs/{id}` (SPEC-13 §6.1). A 204
 * drops the job record — an in-flight worker's eventual result is simply discarded (the thread
 * cannot be force-killed). Resolves on 204 AND on 404 (already gone — cancelling twice, or after
 * the job was dropped, is not an error). When `opts.apiKey` is set it is sent as
 * `Authorization: Bearer <key>`, matching {@link solvePhotos} — the service enforces it on this
 * endpoint when deployed with `PHOTOGRAMMETRY_API_KEY`. Other HTTP errors throw with the server
 * detail. */
export async function cancelJob(id: string, opts: PhotogrammetryCancelOptions = {}): Promise<void> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("photogrammetry: no fetch implementation available");
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  const res = await f(`${base}/jobs/${id}`, {
    method: "DELETE",
    ...(opts.apiKey ? { headers: auth } : {}),
  });
  if (res.ok || res.status === 404) return;
  throw new Error(await httpError(res, "cancel"));
}
