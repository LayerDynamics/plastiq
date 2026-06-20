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
import type { ToolDef, JsonSchema } from "../providers/types.js";
import type { AgentTools, ToolHandler } from "../agentRunner.js";
import type { CadDocument } from "../../store/types.js";

/** The tool whose call ends the agent loop (CADAM-style finalizer). */
export const ANSWER_USER = "answer_user";

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

/** The model-facing tool definitions. `creative` adds create_mesh (the paid 3D path). */
export function toolDefs(opts: { creative: boolean }): ToolDef[] {
  const defs: ToolDef[] = [
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
      name: "create_mesh",
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
}

/** Wire the agent's tools (defs + handlers) from the injected dependencies. The
 * handlers return a string for the model (isError feeds a correction back). */
export function buildAgentTools(deps: AgentToolDeps): AgentTools {
  const handlers: Record<string, ToolHandler> = {
    build_part: async (args) => {
      const document = (args as { document?: unknown }).document;
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
    handlers["create_mesh"] = async (args) => {
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
