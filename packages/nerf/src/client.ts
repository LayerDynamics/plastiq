// @plastiq/nerf — client for the MLX NeRF/surface-capture service (services/nerf).
//
// Submits posed images + a transforms.json to the self-hosted backend and polls for the produced
// GLB (a marching-cubes surface of the trained field). The submit→poll shape mirrors the capture
// and reconstruct services exactly — POST a job, GET /jobs/{id}/status until "completed", then GET
// /jobs/{id}/result — so the browser reuses the same polling machinery. The GLB is then imported as
// a MeshDoc (app-side) and reconstructed into an editable B-rep. Self-hosted, reached by base URL.

import type { NerfOptions, NerfReport, NerfResult, NerfTrainInput } from "./types.js";

/** The documented dev port for services/nerf (reconstruct=8000, capture=8001, nerf=8002). */
const DEFAULT_BASE_URL = "http://localhost:8002";

/** Shape of `GET /jobs/{id}/result` on the nerf service (snake_case wire form). */
interface NerfResultWire {
  glb_base64: string;
  vertices: number;
  faces: number;
  psnr: number;
  method: string;
  iters: number;
}

async function httpError(res: Response, what: string): Promise<string> {
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b.detail ?? "")
    .catch(() => "");
  return `nerf ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

/** Train a NeRF/surface field from posed views and return the reconstructed surface (submit → poll).
 *
 * Throws on submit/status/result HTTP errors, on a `failed` job, on an aborted signal, and on poll
 * timeout. The returned `glb` is a base64 GLB ready to wrap as a MeshDoc. When `opts.apiKey` is set
 * it is sent as `Authorization: Bearer <key>` on EVERY request — the service enforces it on
 * `POST /train` (and `DELETE /jobs/{id}`) when deployed with `NERF_API_KEY`; sending it uniformly
 * keeps the client correct if the read endpoints are ever guarded too (SPEC-11 §5). */
export async function trainNerf(input: NerfTrainInput, opts: NerfOptions = {}): Promise<NerfResult> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("nerf: no fetch implementation available");
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? 2000;
  const maxPolls = opts.maxPolls ?? 600;
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  /** Shared init for the GET polls: bearer auth (if configured) + abort signal (if provided). */
  const getInit: RequestInit = {
    ...(opts.apiKey ? { headers: auth } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const transforms_json =
    typeof input.transformsJson === "string" ? input.transformsJson : JSON.stringify(input.transformsJson);
  const body: Record<string, unknown> = { transforms_json, images: input.images };
  if (input.iters !== undefined) body.iters = input.iters;
  if (input.method !== undefined) body.method = input.method;
  if (input.gridRes !== undefined) body.grid_res = input.gridRes;

  const submitRes = await f(`${base}/train`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!submitRes.ok) throw new Error(await httpError(submitRes, "submit"));
  const submitted = (await submitRes.json()) as { id?: string };
  if (!submitted.id) throw new Error("nerf: submit returned no job id");
  const id = submitted.id;

  for (let i = 0; i < maxPolls; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const statusRes = await f(`${base}/jobs/${id}/status`, getInit);
    if (!statusRes.ok) throw new Error(await httpError(statusRes, "status"));
    const status = (await statusRes.json()) as { state?: string; error?: string };
    opts.onState?.(status.state ?? "?");
    if (status.state === "completed") {
      const resultRes = await f(`${base}/jobs/${id}/result`, getInit);
      if (!resultRes.ok) throw new Error(await httpError(resultRes, "result"));
      const wire = (await resultRes.json()) as NerfResultWire;
      const report: NerfReport = {
        method: wire.method === "neus" ? "neus" : "nerf",
        iters: wire.iters,
        psnr: wire.psnr,
        vertices: wire.vertices,
        faces: wire.faces,
      };
      return { glb: wire.glb_base64, report };
    }
    if (status.state === "failed") {
      throw new Error(`nerf training failed: ${status.error ?? "unknown error"}`);
    }
    await delay(interval);
  }
  throw new Error(`nerf training timed out after ${maxPolls} polls`);
}
