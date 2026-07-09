// @plastiq/nurbs — client for the MLX NURBS surface-fitting service (services/nurbs).
//
// Submits a GLB mesh to the self-hosted backend and polls for the fitted result: STEP text plus
// the validated NURBS-surface JSON (SPEC-12 §6.2) plus a fidelity report (FR-9). The submit→poll
// shape mirrors the capture, reconstruct, and nerf services exactly — POST a job, GET
// /jobs/{id}/status until "completed", then GET /jobs/{id}/result — so the browser reuses the same
// polling machinery. The STEP then feeds the app's existing stepToImportDocument → importStep
// path. Self-hosted, reached by base URL.

import type { NurbsFitInput, NurbsOptions, NurbsReport, NurbsResult, NurbsSurfaceJson } from "./types.js";

/** The documented dev port for services/nurbs (reconstruct=8000, capture=8001, nerf=8002, nurbs=8003). */
const DEFAULT_BASE_URL = "http://localhost:8003";

/** FR-9 report as `GET /jobs/{id}/result` serializes it (snake_case wire form). */
interface NurbsReportWire {
  patches: number;
  fitted_patches: number;
  faceted_patches: number;
  control_points: number;
  degree_u: number;
  degree_v: number;
  iters: number;
  chamfer: number;
  scd: number;
  rms_deviation: number;
  max_deviation: number;
  fidelity_tol: number;
  is_solid: boolean;
  is_valid: boolean;
  mode: string;
}

/** Shape of `GET /jobs/{id}/result` on the nurbs service. `surfaces` is already the §6.2 contract
 * form the client returns verbatim; only the report is snake→camel mapped. */
interface NurbsResultWire {
  step: string;
  surfaces: NurbsSurfaceJson[];
  report: NurbsReportWire;
}

async function httpError(res: Response, what: string): Promise<string> {
  const detail = await res
    .json()
    .then((b: { detail?: string }) => b.detail ?? "")
    .catch(() => "");
  return `nurbs ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
}

/** Fit NURBS surfaces to a GLB mesh and return STEP + surfaces JSON + report (submit → poll).
 *
 * Throws on submit/status/result HTTP errors, on a `failed` job, on an aborted signal, and on poll
 * timeout. The returned `step` is ready for the app's stepToImportDocument → importStep path; the
 * `surfaces` array is the SPEC-12 §6.2 wire JSON, untranslated. When `opts.apiKey` is set it is
 * sent as `Authorization: Bearer <key>` on EVERY request — the service enforces it on `POST /fit`
 * (and `DELETE /jobs/{id}`) when deployed with `NURBS_API_KEY`; sending it uniformly keeps the
 * client correct if the read endpoints are ever guarded too (SPEC-12 §6.1 auth model). */
export async function fitNurbs(input: NurbsFitInput, opts: NurbsOptions = {}): Promise<NurbsResult> {
  const base = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("nurbs: no fetch implementation available");
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? 2000;
  const maxPolls = opts.maxPolls ?? 600;
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  /** Shared init for the GET polls: bearer auth (if configured) + abort signal (if provided). */
  const getInit: RequestInit = {
    ...(opts.apiKey ? { headers: auth } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const body: Record<string, unknown> = { glb_base64: input.glbBase64 };
  if (input.mode !== undefined) body.mode = input.mode;
  if (input.degree !== undefined) body.degree = input.degree;
  if (input.grid !== undefined) body.grid = input.grid;
  if (input.iters !== undefined) body.iters = input.iters;
  if (input.fidelityTol !== undefined) body.fidelity_tol = input.fidelityTol;

  const submitRes = await f(`${base}/fit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!submitRes.ok) throw new Error(await httpError(submitRes, "submit"));
  const submitted = (await submitRes.json()) as { id?: string };
  if (!submitted.id) throw new Error("nurbs: submit returned no job id");
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
      const wire = (await resultRes.json()) as NurbsResultWire;
      const report: NurbsReport = {
        patches: wire.report.patches,
        fittedPatches: wire.report.fitted_patches,
        facetedPatches: wire.report.faceted_patches,
        controlPoints: wire.report.control_points,
        degreeU: wire.report.degree_u,
        degreeV: wire.report.degree_v,
        iters: wire.report.iters,
        chamfer: wire.report.chamfer,
        scd: wire.report.scd,
        rmsDeviation: wire.report.rms_deviation,
        maxDeviation: wire.report.max_deviation,
        fidelityTol: wire.report.fidelity_tol,
        isSolid: wire.report.is_solid,
        isValid: wire.report.is_valid,
        mode: wire.report.mode,
      };
      return { step: wire.step, surfaces: wire.surfaces, report };
    }
    if (status.state === "failed") {
      throw new Error(`nurbs fit failed: ${status.error ?? "unknown error"}`);
    }
    await delay(interval);
  }
  throw new Error(`nurbs fit timed out after ${maxPolls} polls`);
}
