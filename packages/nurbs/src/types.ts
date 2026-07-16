// @plastiq/nurbs — public types for the NURBS surface-fitting client.
//
// These are intentionally decoupled from the app's document model: the package returns STEP text +
// the validated NURBS-surface JSON + a report, and the *app* (apps/plastiq) maps the STEP into its
// own import path (stepToImportDocument → importStep). The dependency direction is
// app → @plastiq/nurbs, never the reverse, so the package stays embeddable anywhere.

/** How the service treats the mesh's topology (SPEC-12 §6.1): auto-detect from boundary loops,
 * or force the open (disk, one patch) / closed (genus-0, six cube-map patches) pipeline. */
export type NurbsFitMode = "auto" | "open" | "closed";

/** The inputs to a fitting job: the mesh plus the fit knobs of `POST /fit` (SPEC-12 §6.1). */
export interface NurbsFitInput {
  /** The mesh to fit, as a base64-encoded GLB. */
  glbBase64: string;
  /** Topology mode (default: the service's `"auto"` detection). */
  mode?: NurbsFitMode;
  /** B-spline degree in both directions (service default 3, bounds 2..8). */
  degree?: number;
  /** Control points per direction (service default 16, bounds 4..64). */
  grid?: number;
  /** Gradient-refinement iterations (service default 200, bounds 0..2000; 0 ⇒ pure LSQ). */
  iters?: number;
  /** Per-patch accuracy gate: max deviation above this ⇒ faceted fallback (FR-5). */
  fidelityTol?: number;
}

/** One fitted B-spline surface — the SPEC-12 §6.2 serialization contract, VERBATIM.
 *
 * This is the service's own wire form (NURBGen-shaped, compact knots, snake_case field names) and
 * is deliberately passed through UNTRANSLATED: the JSON is a validated geometry-exchange format
 * consumed as-is (e.g. by reconstruct's delegation path, FR-10), so renaming its fields here would
 * silently fork the contract. Do not camelCase these. */
export interface NurbsSurfaceJson {
  /** num_u × num_v control points, metres (SPEC-7 D-4 unit convention). */
  poles: number[][][];
  /** [] ⇒ non-rational (all 1.0); else num_u × num_v, all > 0. */
  weights: number[][];
  /** COMPACT form: unique knot values, strictly increasing. */
  u_knots: number[];
  v_knots: number[];
  /** Per-knot multiplicities, parallel to u_knots/v_knots. */
  u_mults: number[];
  v_mults: number[];
  u_degree: number;
  v_degree: number;
  u_periodic: boolean;
  v_periodic: boolean;
}

/** The fitting summary returned alongside the STEP + surfaces (SPEC-12 FR-9), camelCased. */
export interface NurbsReport {
  /** Total patches in the result (1 open, 6 closed). */
  patches: number;
  /** Patches that passed the accuracy gate as fitted NURBS. */
  fittedPatches: number;
  /** Patches that fell back to per-triangle faceted faces (FR-5). */
  facetedPatches: number;
  /** Total control points in the fitted net (nu × nv). */
  controlPoints: number;
  /** B-spline degrees actually used. */
  degreeU: number;
  degreeV: number;
  /** Gradient-refinement iterations actually run. */
  iters: number;
  /** Bidirectional Chamfer distance of the best iterate — the fit-quality headline. */
  chamfer: number;
  /** Scaled Chamfer Distance (StepForge Eqs. 1–3) — scale-invariant fit quality. */
  scd: number;
  /** RMS / max surface deviation from the mesh (metres). */
  rmsDeviation: number;
  maxDeviation: number;
  /** The accuracy gate the deviations were judged against. */
  fidelityTol: number;
  /** Whether the closed-mode sew → MakeSolid produced a solid, and whether it validates. */
  isSolid: boolean;
  isValid: boolean;
  /** The pipeline that ran (`"open"` or `"closed"` after auto-detection). */
  mode: string;
}

/** A completed job: STEP text (feeds the app's stepToImportDocument → importStep path), the
 * validated §6.2 surfaces JSON (verbatim wire form), and the FR-9 report. */
export interface NurbsResult {
  /** The fitted B-rep as STEP text. */
  step: string;
  surfaces: NurbsSurfaceJson[];
  report: NurbsReport;
}

/** Knobs for {@link fitNurbs}: where the service lives, how to talk to it, and how to poll. */
export interface NurbsOptions {
  /** Base URL of the NURBS service. Default `http://localhost:8003` (the documented dev port). */
  baseURL?: string;
  /** API key for a key-protected deployment (the service's `NURBS_API_KEY`) — sent as
   * `Authorization: Bearer <key>` on every request. Absent ⇒ no auth header (open dev default). */
  apiKey?: string;
  /** Injectable fetch (tests pass a fake; defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Max poll attempts before timing out (default 600 ≈ 20 min at 2s — fitting is slow). */
  maxPolls?: number;
  /** Per-poll delay (a constant `pollIntervalMs`, not a backoff; tests inject an instant resolver). */
  delay?: (ms: number) => Promise<void>;
  /** Job-state callback for UI progress (`"queued" | "running" | …`). */
  onState?: (state: string) => void;
  /** Job-id callback, fired once (right after the submit returns, before the first poll) — the
   * handle a caller needs to cancel the in-flight job server-side via {@link cancelJob} while
   * this same call keeps polling. */
  onJob?: (id: string) => void;
}

/** Knobs for {@link cancelJob}: the connection subset of {@link NurbsOptions}. Cancel is a single
 * `DELETE` — the polling knobs don't apply. */
export type NurbsCancelOptions = Pick<NurbsOptions, "baseURL" | "apiKey" | "fetchImpl">;
