// @plastiq/recon — client for services/reconstruct (mesh GLB → B-rep STEP).

import type { ReconstructCancelOptions, ReconstructOptions, ReconstructResult } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:8000";

async function httpError(res: Response, what: string): Promise<string> {
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b.detail ?? "")
    .catch(() => "");
  return `reconstruct ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

/** Reconstruct a mesh (base64 GLB) into a B-rep STEP via the backend (submit → poll).
 *
 * `opts.onJob` fires with the job id right after the submit returns — the handle for cancelling
 * the job server-side ({@link cancelJob}) while this call keeps polling. */
export async function reconstructMesh(
  glbBase64: string,
  opts: ReconstructOptions = {},
): Promise<ReconstructResult> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("reconstruct: no fetch implementation available");
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? 1500;
  const maxPolls = opts.maxPolls ?? 400;
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  const getInit: RequestInit = {
    ...(opts.apiKey ? { headers: auth } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const submitRes = await f(`${base}/reconstruct`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({ glb_base64: glbBase64, ...(opts.method ? { method: opts.method } : {}) }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!submitRes.ok) throw new Error(await httpError(submitRes, "submit"));
  const submitted = (await submitRes.json()) as { id?: string };
  if (!submitted.id) throw new Error("reconstruct: submit returned no job id");
  const id = submitted.id;
  opts.onJob?.(id);

  for (let i = 0; i < maxPolls; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const statusRes = await f(`${base}/jobs/${id}/status`, getInit);
    if (!statusRes.ok) throw new Error(await httpError(statusRes, "status"));
    const status = (await statusRes.json()) as { state?: string; error?: string };
    opts.onState?.(status.state ?? "?");
    if (status.state === "completed") {
      const resultRes = await f(`${base}/jobs/${id}/result`, getInit);
      if (!resultRes.ok) throw new Error(await httpError(resultRes, "result"));
      return (await resultRes.json()) as ReconstructResult;
    }
    if (status.state === "failed") {
      throw new Error(`reconstruction failed: ${status.error ?? "unknown error"}`);
    }
    await delay(interval);
  }
  throw new Error(`reconstruction timed out after ${maxPolls} polls`);
}

/** Cancel/clean up a reconstruction job server-side: `DELETE {baseURL}/jobs/{id}`. Resolves on 204
 * AND on 404 (already gone — cancelling twice is not an error). When `opts.apiKey` is set it is
 * sent as `Authorization: Bearer <key>`, matching {@link reconstructMesh}. Other HTTP errors throw. */
export async function cancelJob(id: string, opts: ReconstructCancelOptions = {}): Promise<void> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("reconstruct: no fetch implementation available");
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  const res = await f(`${base}/jobs/${id}`, {
    method: "DELETE",
    ...(opts.apiKey ? { headers: auth } : {}),
  });
  if (res.ok || res.status === 404) return;
  throw new Error(await httpError(res, "cancel"));
}
