// SPEC-6 R6.6 — client for the mesh→B-rep reconstruction service (services/reconstruct).
//
// Sends a mesh document's inline base64 GLB to the self-hosted reconstruction backend and
// polls for the resulting STEP, which is wrapped as a parametric CadDocument (one
// importStep feature) so it rebuilds through the existing kernel importStep path into an
// editable B-rep part. The submit→poll shape mirrors the fal mesh-gen client. The backend
// is reached by base URL (self-hosted; same BYO/self-host spirit as the AI proxy seam).

import type { CadDocument } from "../store/types.js";

export interface ReconstructReport {
  triangles_in: number;
  triangles_used: number;
  faces_built: number;
  planar_faces: number;
  is_solid: boolean;
  is_valid: boolean;
  method: string;
}

export interface ReconstructResult {
  step: string;
  report: ReconstructReport;
}

export interface ReconstructOptions {
  /** Base URL of the reconstruction service. Default http://localhost:8000. */
  baseURL?: string;
  /** Injectable fetch (tests pass a fake; defaults to global fetch). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Poll interval in ms (default 1500). */
  pollIntervalMs?: number;
  /** Max poll attempts before timing out (default 400 ≈ 10 min at 1.5s). */
  maxPolls?: number;
  /** Poll backoff (tests inject an instant resolver). */
  delay?: (ms: number) => Promise<void>;
  /** Job-state callback for UI progress ("queued" | "running" | …). */
  onState?: (state: string) => void;
}

const DEFAULT_BASE_URL = "http://localhost:8000";

async function httpError(res: Response, what: string): Promise<string> {
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b.detail ?? "")
    .catch(() => "");
  return `reconstruct ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

/** Reconstruct a mesh (base64 GLB) into a B-rep STEP via the backend (submit → poll). */
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

  const submitRes = await f(`${base}/reconstruct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ glb_base64: glbBase64 }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!submitRes.ok) throw new Error(await httpError(submitRes, "submit"));
  const submitted = (await submitRes.json()) as { id?: string };
  if (!submitted.id) throw new Error("reconstruct: submit returned no job id");
  const id = submitted.id;

  for (let i = 0; i < maxPolls; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const statusRes = await f(`${base}/jobs/${id}/status`, opts.signal ? { signal: opts.signal } : {});
    if (!statusRes.ok) throw new Error(await httpError(statusRes, "status"));
    const status = (await statusRes.json()) as { state?: string; error?: string };
    opts.onState?.(status.state ?? "?");
    if (status.state === "completed") {
      const resultRes = await f(`${base}/jobs/${id}/result`, opts.signal ? { signal: opts.signal } : {});
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

/** Wrap reconstructed STEP text as a parametric document (one importStep feature) so it
 * rebuilds via the kernel's importStep path into an editable B-rep part. */
export function stepToImportDocument(step: string, name = "Reconstructed mesh"): CadDocument {
  return { features: [{ id: "f1", type: "importStep", name, data: { step } }], params: {} };
}
