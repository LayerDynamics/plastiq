// @plastiq/capture — client for the MLX capture/completion service (services/capture).
//
// Submits an oriented point cloud (POST /capture) or a partial scan (POST /complete) to the
// self-hosted backend and polls for the produced GLB. The submit→poll shape mirrors the nerf and
// reconstruct services exactly — POST a job, GET /jobs/{id}/status until "completed", then GET
// /jobs/{id}/result — so the browser reuses the same polling machinery. The GLB is then imported
// as a MeshDoc (app-side) and reconstructed into an editable B-rep. Self-hosted, reached by base
// URL. Optional CAPTURE_API_KEY → Authorization: Bearer on mutating requests (T36).

import type { CaptureInput, CaptureOptions, CaptureResult, CompleteInput } from "./types.js";

/** The documented dev port for services/capture (reconstruct=8000, capture=8001, nerf=8002). */
const DEFAULT_BASE_URL = "http://localhost:8001";

/** Shape of `GET /jobs/{id}/result` on the capture service (snake_case wire form) — the same
 * `{glb_base64, vertices, faces}` for both /capture and /complete jobs (main.py). */
interface CaptureResultWire {
  glb_base64: string;
  vertices: number;
  faces: number;
  /** Set on /complete when synthetic demo weights are in use (server main.py). */
  demo_weights?: boolean;
}

async function httpError(res: Response, label: string, what: string): Promise<string> {
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b.detail ?? "")
    .catch(() => "");
  return `${label} ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

/** Cancel a job server-side (`DELETE /jobs/{id}`). Capture force-stops the spawn worker
 * (services/capture JobStore.cancel). Idempotent on 404. */
export async function cancelJob(
  jobId: string,
  opts: Pick<CaptureOptions, "baseURL" | "fetchImpl" | "signal" | "apiKey"> = {},
): Promise<void> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("capture cancelJob: no fetch implementation available");
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  const res = await f(`${base}/jobs/${jobId}`, {
    method: "DELETE",
    headers: { ...auth },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.status === 204 || res.status === 404) return;
  throw new Error(await httpError(res, "cancelJob", "cancel"));
}

/** Shared submit→poll runner for both endpoints. Throws on submit/status/result HTTP errors
 * (surfacing the server's `detail` — its 400 validation messages, the 404 "no such job", the 409
 * not-complete, and the 500 failed-job relay), on a `failed` job status, on an aborted signal,
 * and on poll timeout. */
async function runJob(
  path: "/capture" | "/complete",
  body: Record<string, unknown>,
  label: string,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error(`${label}: no fetch implementation available`);
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? 1000;
  const maxPolls = opts.maxPolls ?? 600;
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  const getInit: RequestInit = {
    ...(opts.apiKey ? { headers: auth } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const submitRes = await f(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!submitRes.ok) throw new Error(await httpError(submitRes, label, "submit"));
  const submitted = (await submitRes.json()) as { id?: string };
  if (!submitted.id) throw new Error(`${label}: submit returned no job id`);
  const id = submitted.id;
  opts.onJob?.(id);

  for (let i = 0; i < maxPolls; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const statusRes = await f(`${base}/jobs/${id}/status`, getInit);
    if (!statusRes.ok) throw new Error(await httpError(statusRes, label, "status"));
    const status = (await statusRes.json()) as { state?: string; error?: string };
    opts.onState?.(status.state ?? "?");
    if (status.state === "completed") {
      const resultRes = await f(`${base}/jobs/${id}/result`, getInit);
      if (!resultRes.ok) throw new Error(await httpError(resultRes, label, "result"));
      const wire = (await resultRes.json()) as CaptureResultWire;
      return {
        glb: wire.glb_base64,
        report: {
          vertices: wire.vertices,
          faces: wire.faces,
          ...(wire.demo_weights !== undefined ? { demoWeights: wire.demo_weights } : {}),
        },
      };
    }
    if (status.state === "failed") {
      throw new Error(`${label} failed: ${status.error ?? "unknown error"}`);
    }
    await delay(interval);
  }
  throw new Error(`${label} timed out after ${maxPolls} polls`);
}

/** Reconstruct a watertight mesh from an ORIENTED point cloud (submit → poll `POST /capture`).
 *
 * The returned `glb` is a base64 GLB ready to wrap as a MeshDoc. Throws on the server's 400
 * validation errors (Nx3 shape / points-normals length mismatch / non-finite values / fewer than
 * {@link MIN_POINTS} points), on a `failed` job, on an aborted signal, and on poll timeout. */
export async function capturePointCloud(input: CaptureInput, opts: CaptureOptions = {}): Promise<CaptureResult> {
  const body: Record<string, unknown> = { points: input.points, normals: input.normals };
  if (input.iters !== undefined) body.iters = input.iters;
  if (input.gridRes !== undefined) body.grid_res = input.gridRes;
  return runJob("/capture", body, "capture", opts);
}

/** Complete a PARTIAL scan (points only, holes allowed) into a full mesh (submit → poll
 * `POST /complete`, the M8 shape-completion path). Same result shape as {@link capturePointCloud}. */
export async function completePartialScan(input: CompleteInput, opts: CaptureOptions = {}): Promise<CaptureResult> {
  const body: Record<string, unknown> = { points: input.points };
  if (input.gridRes !== undefined) body.grid_res = input.gridRes;
  return runJob("/complete", body, "completion", opts);
}
