// SPEC-12 U9.3 — app-side adapter for the MLX NURBS surface-fitting service (@plastiq/nurbs).
//
// The browser client (submit→poll a /fit job) lives in the @plastiq/nurbs workspace package; this
// thin app module maps its result into the app's own document model. A mesh document's GLB is
// fitted server-side (MLX, Apple Silicon, port :8003) into smooth B-spline surfaces; the returned
// STEP is wrapped via the SAME stepToImportDocument → importStep path the reconstruct conversion
// uses, so the fit lands as an editable B-rep part. The FR-9 report is surfaced (isSolid /
// facetedPatches / deviations) for honest UX labeling (NFR-5): NURBS smooths — mechanical parts
// stay the reconstruct service's job. The dependency direction is app → @plastiq/nurbs, never the
// reverse.

import {
  cancelJob,
  fitNurbs,
  type NurbsCancelOptions,
  type NurbsOptions,
  type NurbsReport,
} from "@plastiq/nurbs";

import { useAiStore } from "./aiStore.js";
import { commitStepDocument, stepToImportDocument } from "./reconstruct.js";
import type { BuildProbe } from "./tools/buildPart.js";
import type { CadDocument } from "../store/types.js";

/** The @plastiq/nurbs client default (services/nurbs dev port) — kept here for the panel's
 * pre-flight /health probe, mirroring RECONSTRUCT/NERF/CAPTURE_DEFAULT_BASE_URL (errorHints.ts). */
export const NURBS_DEFAULT_BASE_URL = "http://localhost:8003";

/** The "service unreachable" line for the mesh section's error slot, with the documented dev
 * start command (services/nurbs/README) — the serviceUnreachableMessage wording. */
export function nurbsUnreachableMessage(baseURL: string): string {
  return `NURBS fitting service unreachable at ${baseURL} — start it with: mamba run -n plastiq-nurbs uvicorn app.main:app --port 8003 (in services/nurbs).`;
}

export interface FitMeshToCadDeps {
  /** Apply the resulting CAD document (e.g. useCadStore.getState().replaceDocument). */
  load: (doc: CadDocument) => void;
  /** Prove the fitted STEP builds BEFORE it replaces the document (§2.12.2) —
   * the real-OCCT build probe. Required: committing unvalidated service STEP is
   * exactly the destructive path this seam exists to prevent. */
  probe: BuildProbe;
}

/** Resolve connection knobs from settings unless the caller overrides them. */
function withNurbsSettings<T extends NurbsCancelOptions>(opts: T): T {
  const settings = useAiStore.getState().settings;
  const baseURL = opts.baseURL ?? settings?.nurbsBaseURL;
  const apiKey = opts.apiKey ?? settings?.nurbsApiKey;
  return {
    ...opts,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Fit smooth NURBS surfaces to a mesh (base64 GLB) and load the resulting STEP as an editable
 * B-rep document. Returns the loaded CadDocument and the FR-9 fitting report so the caller can
 * label the result honestly (shell vs solid, faceted fallbacks — NFR-5).
 *
 * Resolution (SPEC-12 §6.1, the nerf.ts precedent): a caller-supplied `opts.baseURL`/`opts.apiKey`
 * wins; otherwise the persisted `nurbsBaseURL`/`nurbsApiKey` settings are threaded into `fitNurbs`
 * (the key is sent as `Authorization: Bearer <key>` on every request); neither ⇒ the client
 * default base URL and no auth header (the open dev service).
 *
 * `opts.onJob` yields the job id so the panel can cancel it mid-poll via {@link cancelFit}. */
export async function fitMeshToCad(
  glbBase64: string,
  deps: FitMeshToCadDeps,
  opts: NurbsOptions = {},
  name = "Fitted mesh",
): Promise<{ doc: CadDocument; report: NurbsReport }> {
  const result = await fitNurbs({ glbBase64 }, withNurbsSettings(opts));
  // Validate-then-commit (§2.12.2): throws without touching the store if the
  // service returned STEP the kernel cannot build.
  const doc = await commitStepDocument(stepToImportDocument(result.step, name), {
    probe: deps.probe,
    load: deps.load,
  });
  return { doc, report: result.report };
}

/** Cancel a NURBS fit job server-side (`DELETE /jobs/{id}`, M4b) — the counterpart to
 * {@link fitMeshToCad} for the panel's Cancel: aborting the client-side polling alone would leave
 * the server fitting for nobody. The job id comes from `opts.onJob`. Resolves on 204 and on 404
 * (already gone). Auth/base URL are threaded exactly like the fit path. */
export async function cancelFit(jobId: string, opts: NurbsCancelOptions = {}): Promise<void> {
  await cancelJob(jobId, withNurbsSettings(opts));
}

/** The honest FR-9/NFR-5 one-liner for the panel status (the reconstruct "converted to CAD — …"
 * precedent): patch count, solid vs shell, deviation-vs-tolerance fidelity, and any faceted
 * fallback patches — nothing a coarse fit could hide behind. */
export function nurbsFitStatusMessage(report: NurbsReport): string {
  const patches = `${report.patches} patch${report.patches === 1 ? "" : "es"}`;
  const solidity = report.isSolid ? "solid" : "shell (not a solid)";
  const fidelity = report.maxDeviation <= report.fidelityTol ? "good" : "coarse";
  const faceted =
    report.facetedPatches > 0 ? `, ${report.facetedPatches} of ${report.patches} faceted (fallback)` : "";
  return `fitted smooth CAD (NURBS) — ${patches}, ${solidity}, fidelity ${fidelity} (Δ${report.maxDeviation.toFixed(4)})${faceted}`;
}
