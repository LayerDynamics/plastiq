// Shared HTTP helpers for ML job services: error formatting + DELETE cancel.

import type { JobCancelOptions } from "./types.js";

/** Read FastAPI `{ detail }` (or empty) and format a stable client error string. */
export async function serviceHttpError(res: Response, label: string, what: string): Promise<string> {
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b.detail ?? "")
    .catch(() => "");
  return `${label} ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

export interface CancelServiceJobOptions extends JobCancelOptions {
  /** Fallback base URL when `baseURL` is omitted (domain default port). */
  defaultBaseURL: string;
  /**
   * Prefix for error messages (e.g. `"reconstruct"`, `"nerf"`).
   * Cancel failures become `${label} cancel: HTTP …`.
   */
  label: string;
}

/**
 * Cancel/clean up a job server-side: `DELETE {baseURL}/jobs/{id}`.
 *
 * Resolves on 2xx and on 404 (already gone — cancelling twice is not an error).
 * When `apiKey` is set it is sent as `Authorization: Bearer <key>`. Other HTTP
 * errors throw with the server detail.
 *
 * Capture's server force-kills the spawn worker; other services drop the record
 * (thread/process work may continue until their own caps). Callers still benefit
 * from DELETE so orphaned job records and (where supported) workers are cleaned up.
 */
export async function cancelServiceJob(jobId: string, opts: CancelServiceJobOptions): Promise<void> {
  const base = (opts.baseURL ?? opts.defaultBaseURL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error(`${opts.label}: no fetch implementation available`);
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  const res = await f(`${base}/jobs/${jobId}`, {
    method: "DELETE",
    ...(opts.apiKey ? { headers: auth } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.ok || res.status === 404) return;
  throw new Error(await serviceHttpError(res, opts.label, "cancel"));
}
