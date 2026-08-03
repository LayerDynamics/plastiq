// SPEC-6 R2.1 — the `build_part` tool handler (FR-6, FR-7, FR-21).
//
// The browser is the compiler (decision 2): the model emits an authoring document
// (mm/deg); this handler validates it, converts to SI, **builds it off to the side
// first**, and only on success applies it to the live store (atomic — FR-21). On any
// failure the live document is untouched and a structured error is returned to the
// model so it can self-correct (FR-7).
//
// The build "probe" and the "apply" are injected so this is testable against real
// OCCT in node (rebuildDocument) and wired to GeometryClient.build / loadDocument in
// the app — see `geometryClientProbe`.

import type { ZodError } from "zod";
import { describeOcctError } from "@plastiq/cad";
import { authoringDocumentSchema, cadDocumentSchema, toCadDocument, type AuthoringDocument } from "./schema.js";
import type { CadDocument } from "../../store/types.js";
import type { GeometryClient } from "../../worker/bridge.js";

/** Result of an off-thread build attempt — ok, or a human/model-readable error. */
export interface BuildProbeResult {
  ok: boolean;
  error?: string;
}
/** Build the document off the live store to verify it compiles (no side effects). */
export type BuildProbe = (doc: CadDocument) => Promise<BuildProbeResult>;
/** Commit a validated, built document to the live store (loadDocument in the app). */
export type ApplyDocument = (doc: CadDocument) => void;

export interface BuildPartDeps {
  probe: BuildProbe;
  apply: ApplyDocument;
}

export interface BuildPartResult {
  status: "ok" | "error";
  /** A short user-facing message (returned to the model as the tool result). */
  message: string;
  /** Structured failure detail for the model to self-correct (FR-7). */
  errors?: string;
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Run the build_part tool: validate(mm/deg) → convert(SI) → validate(SI) → build
 * off-thread → apply. Returns ok or a structured error; never applies a document
 * that failed any step (atomic).
 */
export async function buildPart(input: unknown, deps: BuildPartDeps): Promise<BuildPartResult> {
  // Guard a common model mistake BEFORE schema parse: features dumped under
  // "assembly" (a real AssemblyModel carries components/mates, not features).
  // rebuildDocument only evaluates doc.features, so these would SILENTLY vanish —
  // fail loudly with a named message so the model moves them into "features".
  // (Schema parse alone would only say "did not match schema", which hides the fix.)
  const strayFeatures = (input as { assembly?: { features?: unknown } }).assembly?.features;
  if (Array.isArray(strayFeatures) && strayFeatures.length > 0) {
    return {
      status: "error",
      message: 'Features must go in the top-level "features" array, not "assembly".',
      errors: `${strayFeatures.length} feature(s) were under "assembly" and would be ignored — move them into "features" in build order. The document has only "features" and "params".`,
    };
  }

  const parsed = authoringDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "The document did not match the build_part schema.", errors: formatZodError(parsed.error) };
  }

  // Convert the ORIGINAL validated input (not the zod-parsed copy) so no fields are
  // stripped; validity is already guaranteed by safeParse above.
  let si: CadDocument;
  try {
    si = toCadDocument(input as AuthoringDocument);
  } catch (e) {
    return { status: "error", message: "Unit conversion (mm/deg → SI) failed.", errors: e instanceof Error ? e.message : String(e) };
  }

  const gate = cadDocumentSchema.safeParse(si);
  if (!gate.success) {
    return { status: "error", message: "The converted document failed validation.", errors: formatZodError(gate.error) };
  }

  const probe = await deps.probe(si);
  if (!probe.ok) {
    return { status: "error", message: "The model did not compile.", errors: probe.error ?? "unknown build error" };
  }

  // Success: the live store is updated only now (atomic).
  deps.apply(si);
  const n = si.features.length;
  return { status: "ok", message: `Built the part (${n} feature${n === 1 ? "" : "s"}).` };
}

/** App probe: build the document in the geometry worker. A null mesh (the worker's
 * signal for a failed/empty build — see bridge.build) is reported as an error; the
 * timeline already flags the offending feature via the Viewport's rebuild. Accepts
 * anything with GeometryClient's `build` shape: the app wraps the `__plastiqBuild`
 * seam the Viewport publishes off its single worker (agentTurn.buildTurnTools), and a
 * direct GeometryClient works too. */
export function geometryClientProbe(client: Pick<GeometryClient, "build">): BuildProbe {
  return async (doc) => {
    try {
      const { mesh, statuses } = await client.build(doc);
      // The rebuild ISOLATES per-feature failures, so a document with a broken
      // feature can still hand back geometry. A probe that only checked for a
      // mesh would green-light a partially-failed document — report the failed
      // features instead, naming them.
      const failed = statuses.filter((s) => s.status === "error");
      if (failed.length > 0) {
        return {
          ok: false,
          error: failed.map((s) => s.message ?? `feature '${s.featureId}' failed`).join("; "),
        };
      }
      return mesh
        ? { ok: true }
        : { ok: false, error: "the document produced no geometry" };
    } catch (e) {
      return { ok: false, error: describeOcctError(e) };
    }
  };
}
