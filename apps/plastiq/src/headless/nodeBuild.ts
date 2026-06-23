// SPEC-6 R2 — headless geometry seam for the parametric agent.
//
// In the browser, the build_part / inspect_geometry tools run the document through
// the geometry *worker* (the `__plastiqBuild` global) and apply it to the Zustand
// store (see ai/agentTurn.ts). None of that exists off the main thread. This module
// provides the SAME AgentToolDeps backed directly by @plastiq/cad in Node, so the
// generation agent — provider + tool loop + prompt + zod validation, unchanged —
// runs headlessly (the CADGenBench harness, CI, any script). It is the Node twin of
// buildTurnTools(): same probe/apply/inspect contract, different backend.
//
// Pure (oc, document) functions, exactly like worker/rebuild.ts — no browser, no
// store, no globals.

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initOcct, exportStep, type Occt } from "@plastiq/cad";
import { rebuildDocument, rebuildTagged } from "../worker/rebuild.js";
import { buildAgentTools, type AgentToolDeps } from "../ai/tools/toolDefs.js";
import type { AgentTools } from "../ai/agentRunner.js";
import type { BuildProbe, ApplyDocument } from "../ai/tools/buildPart.js";
import type { MeshProbe } from "../ai/tools/inspectGeometry.js";
import type { ToolDef, JsonSchema } from "../ai/providers/types.js";
import type { CadDocument } from "../store/types.js";

/**
 * Inline a JSON-Schema's `$ref`/`$defs` so grammar-constrained backends accept it.
 *
 * zod emits `$ref` + `$defs` for the recursive feature union in `build_part`'s
 * schema. Grammar-constraining servers (llama.cpp) build a GBNF from each tool's
 * schema and **400** when they can't resolve those refs. We dereference: replace
 * each `$ref` with the referenced definition inline, breaking the one recursive
 * cycle (`boolean.data.toolFeatures` → the feature union) by substituting a generic
 * object the second time a definition is entered, and stripping `$defs`/`$schema`.
 * Crucially this PRESERVES the concrete feature shapes (e.g. `box.params.dx/dy/dz`),
 * so the model still gets precise field guidance — collapsing to a bare object
 * loses that and the model invents field names (`length`/`width`/`height`).
 */
function dereferenceSchema(schema: JsonSchema): JsonSchema {
  // zod nests `$defs` inside the property it applies to (e.g. properties.document),
  // not at the tool-schema root — gather every `$defs` block first so refs resolve.
  const defs: Record<string, JsonSchema> = {};
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(collect);
    } else if (node && typeof node === "object") {
      const block = (node as { $defs?: Record<string, JsonSchema> }).$defs;
      if (block) Object.assign(defs, block);
      Object.values(node as Record<string, unknown>).forEach(collect);
    }
  };
  collect(schema);

  const walk = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, seen));
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const ref = obj["$ref"];
      if (typeof ref === "string") {
        const name = ref.split("/").pop() ?? "";
        if (seen.has(name) || !defs[name]) return { type: "object" }; // break cycle / unknown ref
        return walk(defs[name], new Set(seen).add(name));
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$defs" || k === "$schema") continue;
        out[k] = walk(v, seen);
      }
      return out;
    }
    return node;
  };
  return walk(schema, new Set<string>()) as JsonSchema;
}

/** Dereference any tool whose schema uses `$ref`/`$defs`/`$schema`; pass the rest
 * through unchanged (so `answer_user`'s `message: string` keeps its precise type). */
export function grammarSafeToolDefs(defs: ToolDef[]): ToolDef[] {
  return defs.map((d) => {
    const json = JSON.stringify(d.parameters);
    if (!json.includes("$ref") && !json.includes("$defs") && !json.includes("$schema")) {
      return d;
    }
    return { ...d, parameters: dereferenceSchema(d.parameters) };
  });
}

/** The Emscripten-generated OCCT/planegcs glue the kernel loads is Node-CJS: it
 * references ``__dirname``/``__filename`` and calls ``require('fs'|'path'|...)`` to
 * read the wasm at runtime. Under a pure-ESM runner (tsx, ``node --import``) those
 * CJS globals are undefined and kernel init aborts; Vitest injects them, which is
 * why the unit suite is unaffected. Define them once (idempotently) from this
 * module's URL so the headless path runs off the bundler too. The wasm path itself
 * is resolved separately in ``@plastiq/cad`` via ``import.meta.url``. */
function ensureNodeCjsGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g["require"] === "function") return;
  const filename = fileURLToPath(import.meta.url);
  g["__filename"] = filename;
  g["__dirname"] = dirname(filename);
  g["require"] = createRequire(import.meta.url);
}

/** Tessellation deflection (SI metres) for the build probe + inspect mesh — matches
 * the app's `GeometryClient.build` default (0.5 mm). STEP export is B-rep, so the
 * exported geometry is exact regardless of this. */
export const HEADLESS_DEFLECTION = 0.0005;

/** A fresh parametric document (the starting point for a generation task). */
export const EMPTY_DOCUMENT: CadDocument = { features: [], params: {} };

export interface HeadlessSession {
  readonly oc: Occt;
  /** The wired agent tools (build_part, inspect_geometry, plan_part, answer_user). */
  readonly tools: AgentTools;
  /** The latest successfully-applied document — the generation/edit result. */
  currentDoc(): CadDocument;
  /** True iff build_part successfully applied at least once this session. For an
   * editing seed, `false` means the model never changed the imported solid (a
   * no-op edit that re-exports the input), distinct from a real edit. */
  applied(): boolean;
  /** Rebuild the current document and export it as STEP text. Throws if the
   * document produces no geometry. */
  toStep(): string;
}

/**
 * Create a headless agent session over real OCCT.
 *
 * `seed` is the starting document: an imported STEP for an editing task (see
 * {@link seedFromStep}), or {@link EMPTY_DOCUMENT} for generation. The agent's
 * build_part handler probes each candidate document by actually rebuilding it
 * through the kernel, and only a document that compiles is captured — identical
 * atomic-apply semantics to the browser, minus the worker round-trip.
 */
export async function createHeadlessSession(
  seed: CadDocument = EMPTY_DOCUMENT,
): Promise<HeadlessSession> {
  ensureNodeCjsGlobals();
  const oc = await initOcct();
  let current: CadDocument = seed;
  let didApply = false;

  // build_part only needs to know the document compiles, so rebuild WITHOUT
  // tessellating (the agent may probe many candidate docs per run; tessellation is
  // the expensive step and the mesh is discarded). inspect_geometry genuinely needs
  // the tagged mesh, so meshProbe tessellates.
  const probe: BuildProbe = async (doc) => {
    try {
      const solid = rebuildDocument(oc, doc);
      if (!solid) {
        return { ok: false, error: "the document produced no geometry or a feature failed to build" };
      }
      solid.delete();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const apply: ApplyDocument = (doc) => {
    current = doc;
    didApply = true;
  };
  const meshProbe: MeshProbe = async (doc) =>
    rebuildTagged(oc, doc, { linearDeflection: HEADLESS_DEFLECTION });

  // No createMesh dep: the headless path is parametric-only (the creative img→3D
  // path needs paid cloud providers + a browser). plan_part / inspect_geometry /
  // answer_user are wired automatically by buildAgentTools.
  const deps: AgentToolDeps = {
    buildPart: { probe, apply },
    probe: meshProbe,
    currentDoc: () => current,
  };

  const tools = buildAgentTools(deps);
  return {
    oc,
    // Grammar-safe tool schemas so local grammar-constrained backends (llama.cpp)
    // don't 400 on the zod $ref/$defs; the prompt carries the full schema.
    tools: { defs: grammarSafeToolDefs(tools.defs), handlers: tools.handlers },
    currentDoc: () => current,
    applied: () => didApply,
    toStep: () => {
      const solid = rebuildDocument(oc, current);
      if (!solid) throw new Error("current document has no geometry to export");
      try {
        return exportStep(oc, solid);
      } finally {
        solid.delete();
      }
    },
  };
}

/**
 * Author a STEP string directly from a CadDocument via the kernel — no agent, no
 * model. The document is in SI units (metres/radians), like the live store. Used to
 * author self-owned **ground-truth** solids for local scoring (the CB6.3 mini-GT
 * workflow), e.g. a plate with a hole: box → sketch(circle) → cut.
 */
export async function authorStep(doc: CadDocument): Promise<string> {
  ensureNodeCjsGlobals();
  const oc = await initOcct();
  const solid = rebuildDocument(oc, doc);
  if (!solid) throw new Error("document produced no geometry to export");
  try {
    return exportStep(oc, solid);
  } finally {
    solid.delete();
  }
}

/** Build an `importStep` seed document from STEP text — the editing-task starting
 * solid, loaded the same way the app's reconstruct path does (one opaque body the
 * agent then modifies by adding features). */
export function seedFromStep(stepText: string): CadDocument {
  return {
    features: [{ id: "import", type: "importStep", data: { step: stepText } }],
    params: {},
  };
}
