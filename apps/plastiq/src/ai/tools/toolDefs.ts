// SPEC-6 R2.4 — the tool surface (§7.1) wiring: the ToolDef[] the model sees and the
// AgentTools (defs + handlers) the agentRunner dispatches. This is the glue between the
// streaming provider and the client-side handlers (buildPart / inspectGeometry /
// createMesh), with every side-effecting dependency injected so the same wiring serves
// the GenerationPanel (real GeometryClient + projectsStore) and the deterministic E2E
// seam (real handlers, no model). Tool inputs mirror CADAM's build/create surface.

import { z } from "zod";
import { authoringDocumentSchema } from "./schema.js";
import { buildPart, type BuildPartDeps } from "./buildPart.js";
import { inspectGeometry, type MeshProbe } from "./inspectGeometry.js";
import { createMesh, type CreateMeshDeps } from "./createMesh.js";
import { planSchema, summarizePlan, validatePlan, type PlanGraph } from "../planning.js";
import type { ToolDef, JsonSchema } from "../providers/types.js";
import type { AgentTools, ToolHandler } from "../agentRunner.js";
import type { CadDocument } from "../../store/types.js";

/** The tool whose call ends the agent loop (CADAM-style finalizer). */
export const ANSWER_USER = "answer_user";

/** The creative 3D-gen tool (the paid path). Named so the prompt assembly can derive the
 * creative guidance from the actual tool surface (runGeneration) without string drift. */
export const CREATE_MESH = "create_mesh";

/** JSON Schema for the authoring document, derived from the single zod source so the
 * tool contract never drifts from the validator. Falls back to a permissive object
 * schema if zod's converter can't represent the schema — the handler's zod parse is the
 * real gate, and prompt.ts enumerates the full schema for the model regardless. */
function authoringJsonSchema(): JsonSchema {
  try {
    return z.toJSONSchema(authoringDocumentSchema) as JsonSchema;
  } catch {
    return { type: "object", description: "An authoring CadDocument (mm/deg); see the system prompt for the schema." };
  }
}

/** JSON Schema for the M5 planning IR (decomposition graph), from the single zod source. */
function planJsonSchema(): JsonSchema {
  try {
    return z.toJSONSchema(planSchema) as JsonSchema;
  } catch {
    return { type: "object", description: "A decomposition graph: { nodes:[{id,part,parent?}], relations:[{from,to,kind}] }." };
  }
}

/** The model-facing tool definitions. `creative` adds create_mesh (the paid 3D path). */
export function toolDefs(opts: { creative: boolean }): ToolDef[] {
  const defs: ToolDef[] = [
    {
      name: "plan_part",
      description:
        "For a COMPLEX or multi-part object, FIRST decompose it into a plan graph before building: nodes are sub-parts ({ id, part, parent? }, hierarchy via parent), relations are spatial/constraint edges ({ from, to, kind } with kind aligned|attached|coaxial|offset|pattern|symmetric|contains). The browser validates structure (referential integrity, acyclic) and returns it; then call build_part referencing the node ids. Skip this for a simple single part.",
      parameters: planJsonSchema(),
    },
    {
      name: "build_part",
      description:
        "Build or replace the parametric CAD part from an authoring document (lengths in mm, angles in degrees). The browser validates and compiles it; on success it becomes the live editable model. When editing the current part, send the full modified document.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["document"],
        properties: { document: authoringJsonSchema() },
      },
    },
    {
      name: "inspect_geometry",
      description:
        "Return a text enumeration of the current part's faces and edges (normals, centroids, areas, lengths in mm). Call this before adding a dress-up (fillet/chamfer/shell/draft) if you are unsure which face or edge to target; then reference faces/edges by their normal + centroid, or use a named selector.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: ANSWER_USER,
      description: "Finish the task with a short message to the user describing what you built or changed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string" } },
      },
    },
  ];
  if (opts.creative) {
    defs.push({
      name: CREATE_MESH,
      description:
        "Generate a 3D mesh (organic/sculpted geometry the parametric kernel cannot author) via a cloud provider, as a NEW mesh document. Modes: text2img3d (generate an image then 3D), img3d (an attached image), text3d (direct text→3D where supported). This is a PAID job; the user confirms before it runs.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "providerId"],
        properties: {
          mode: { type: "string", enum: ["text2img3d", "img3d", "text3d"] },
          prompt: { type: "string" },
          imageId: { type: "string" },
          providerId: { type: "string" },
          quality: { type: "string" },
        },
      },
    });
  }
  return defs;
}

export interface AgentToolDeps {
  /** build_part: off-thread probe + atomic apply (geometryClientProbe + loadDocument). */
  buildPart: BuildPartDeps;
  /** inspect_geometry: build the current doc and return its tagged mesh. */
  probe: MeshProbe;
  /** Snapshot of the live document for inspect_geometry. */
  currentDoc: () => CadDocument;
  /** create_mesh deps — when present, the creative tool is offered + wired. */
  createMesh?: CreateMeshDeps;
  /** M5: called when the agent commits a (validated) decomposition plan, so the trace/UX
   * can show it (9-M1). Both production runners inject it: buildTurnTools (agentTurn.ts)
   * records the FULL plan into the conversation trace (kind "plan") and the panel renders
   * it structured; the headless session (headless/nodeBuild.ts) reports it via plan(). */
  onPlan?: (plan: PlanGraph) => void;
}

/**
 * Re-inject the original STEP text into any `importStep` feature the model
 * re-emitted without it.
 *
 * Edit-mode shows the model the current document with each imported body's STEP
 * **digested** (raw STEP omitted to keep the prompt small — see
 * `ai/editContext.ts`). When the model then re-emits "the WHOLE updated document",
 * its `importStep` features carry the digest, not the STEP text — which fails the
 * `data.step` schema gate and is unrepairable (the model never had the bytes).
 * Here we match each such feature to the live document by feature id and restore
 * its real `data.step`, so an edit of an imported solid round-trips. A feature the
 * model supplied with its own STEP, or one with no id match, is left untouched.
 */
export function reconcileImportSteps(document: unknown, currentDoc: CadDocument): unknown {
  if (!document || typeof document !== "object") return document;
  const doc = document as { features?: unknown };
  if (!Array.isArray(doc.features)) return document;

  const stepById = new Map<string, string>();
  for (const f of currentDoc.features) {
    if (f.type === "importStep") {
      const s = f.data?.["step"];
      if (typeof s === "string" && s.length > 0) stepById.set(f.id, s);
    }
  }
  if (stepById.size === 0) return document;

  const features = doc.features.map((f) => {
    if (!f || typeof f !== "object") return f;
    const feat = f as { id?: unknown; type?: unknown; data?: Record<string, unknown> };
    if (feat.type !== "importStep") return f;
    const supplied = feat.data?.["step"];
    if (typeof supplied === "string" && supplied.length > 0) return f; // model gave a STEP
    const id = typeof feat.id === "string" ? feat.id : undefined;
    const original = id ? stepById.get(id) : undefined;
    if (original === undefined) return f; // no match → let the schema reject it
    return { ...feat, data: { ...feat.data, step: original } };
  });
  return { ...doc, features };
}

/** Wire the agent's tools (defs + handlers) from the injected dependencies. The
 * handlers return a string for the model (isError feeds a correction back). */
export function buildAgentTools(deps: AgentToolDeps): AgentTools {
  const handlers: Record<string, ToolHandler> = {
    plan_part: async (args) => {
      // No geometry side effects — validate the decomposition graph and record it. A malformed plan
      // returns its error so the model fixes the structure before building (M5; docs/adr/0005).
      const v = validatePlan(args);
      if (!v.ok) return { result: `Plan rejected: ${v.error}`, isError: true };
      deps.onPlan?.(v.plan);
      return { result: summarizePlan(v.plan), isError: false };
    },
    build_part: async (args) => {
      // Restore the STEP bytes for any imported body the model re-emitted from its
      // (digested) edit context, so an edit of an imported solid validates.
      const document = reconcileImportSteps((args as { document?: unknown }).document, deps.currentDoc());
      const r = await buildPart(document, deps.buildPart);
      return {
        result: r.status === "ok" ? r.message : `${r.message}${r.errors ? ` Errors: ${r.errors}` : ""}`,
        isError: r.status === "error",
      };
    },
    inspect_geometry: async () => {
      const r = await inspectGeometry(deps.currentDoc(), deps.probe);
      return { result: r.text, isError: false };
    },
    [ANSWER_USER]: async (args) => {
      const message = (args as { message?: unknown }).message;
      return { result: typeof message === "string" ? message : "Done.", isError: false };
    },
  };

  if (deps.createMesh) {
    const cm = deps.createMesh;
    handlers[CREATE_MESH] = async (args) => {
      const r = await createMesh(args, cm);
      const detail =
        r.status === "ok"
          ? `${r.message} (meshDocId: ${r.meshDocId})`
          : `${r.message}${r.errors ? ` Errors: ${r.errors}` : ""}`;
      return { result: detail, isError: r.status === "error" };
    };
  }

  return { defs: toolDefs({ creative: deps.createMesh != null }), handlers };
}
