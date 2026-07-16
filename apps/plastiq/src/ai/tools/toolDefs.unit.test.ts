// SPEC-6 R2.4 — the tool surface (§7.1) defs + AgentTools dispatch wiring.

import { describe, expect, it, vi } from "vitest";
import { ANSWER_USER, buildAgentTools, reconcileImportSteps, toolDefs, type AgentToolDeps } from "./toolDefs.js";
import { runAgent, type AgentTools } from "../agentRunner.js";
import { authoringDocumentSchema } from "./schema.js";
import { editContext } from "../editContext.js";
import type { ChatProvider, StreamEvent } from "../providers/types.js";
import type { CadDocument } from "../../store/types.js";
import type { MeshView } from "./inspectGeometry.js";

const emptyDoc: CadDocument = { features: [], params: {} };

/** A 20mm cube authoring document (mm) — valid build_part input. */
const cubeDoc = {
  features: [{ id: "f1", type: "box", params: { dx: 20, dy: 20, dz: 20 } }],
  params: {},
};

function deps(over: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    buildPart: { probe: async () => ({ ok: true }), apply: () => {} },
    probe: async () => null,
    currentDoc: () => emptyDoc,
    ...over,
  };
}

describe("toolDefs (SPEC-6 §7.1)", () => {
  it("offers plan_part, build_part, inspect_geometry, and answer_user by default (no create_mesh)", () => {
    const names = toolDefs({ creative: false }).map((d) => d.name);
    expect(names).toEqual(["plan_part", "build_part", "inspect_geometry", ANSWER_USER]);
  });

  it("plan_part (M5) declares a decomposition-graph schema", () => {
    const plan = toolDefs({ creative: false }).find((d) => d.name === "plan_part")!;
    expect(plan).toBeDefined();
    expect(plan.parameters).toBeTypeOf("object");
  });

  it("adds create_mesh only in creative mode, with the §7.1 input enum", () => {
    const defs = toolDefs({ creative: true });
    const createMesh = defs.find((d) => d.name === "create_mesh");
    expect(createMesh).toBeDefined();
    const mode = (createMesh!.parameters as { properties: { mode: { enum: string[] } } }).properties.mode;
    expect(mode.enum).toEqual(["text2img3d", "img3d", "text3d"]);
  });

  it("build_part declares a `document` parameter (schema derived from zod, never empty)", () => {
    const buildPart = toolDefs({ creative: false }).find((d) => d.name === "build_part")!;
    const params = buildPart.parameters as { required: string[]; properties: { document: object } };
    expect(params.required).toContain("document");
    expect(params.properties.document).toBeTypeOf("object");
  });
});

describe("reconcileImportSteps (edit round-trip for imported solids)", () => {
  const STEP_TEXT =
    "ISO-10303-21;\nHEADER;\n#1=ADVANCED_FACE();\n#2=MANIFOLD_SOLID_BREP();\nENDSEC;\n";
  const importDoc: CadDocument = {
    features: [{ id: "import", type: "importStep", data: { step: STEP_TEXT } }],
    params: {},
  };

  it("restores STEP bytes the digest dropped, matched by feature id", () => {
    const digested = {
      features: [{ id: "import", type: "importStep", data: { importedSolid: { bytes: 1, faces: 1, solids: 1 } } }],
      params: {},
    };
    const out = reconcileImportSteps(digested, importDoc) as {
      features: { data: { step?: string } }[];
    };
    expect(out.features[0]!.data.step).toBe(STEP_TEXT);
    expect(authoringDocumentSchema.safeParse(out).success).toBe(true);
  });

  it("editContext's digested doc fails the schema, but round-trips after reconcile", () => {
    // This is the exact failure the digest introduced: the model echoes back the
    // digested importStep (no `step`), which the schema rejects — until reconcile.
    const ctx = editContext(importDoc)!;
    const json = ctx.slice(ctx.indexOf("{"), ctx.lastIndexOf("}") + 1);
    const reemitted = JSON.parse(json);
    expect(authoringDocumentSchema.safeParse(reemitted).success).toBe(false);
    const reconciled = reconcileImportSteps(reemitted, importDoc);
    expect(authoringDocumentSchema.safeParse(reconciled).success).toBe(true);
  });

  it("leaves a model-supplied STEP and unmatched ids untouched", () => {
    const supplied = {
      features: [{ id: "x", type: "importStep", data: { step: "ISO-10303-21;own" } }],
      params: {},
    };
    expect(reconcileImportSteps(supplied, importDoc)).toEqual(supplied);
  });

  it("is a no-op when the current doc has no imported bodies", () => {
    const same = { features: [{ id: "f1", type: "box", params: { dx: 10 } }], params: {} };
    expect(reconcileImportSteps(same, emptyDoc)).toBe(same);
  });
});

describe("buildAgentTools dispatch", () => {
  it("build_part unwraps args.document and reports success", async () => {
    const apply = vi.fn();
    const tools = buildAgentTools(deps({ buildPart: { probe: async () => ({ ok: true }), apply } }));
    const res = await tools.handlers["build_part"]!({ document: cubeDoc });
    expect(res.isError).toBe(false);
    expect(res.result).toMatch(/Built the part/);
    expect(apply).toHaveBeenCalledOnce(); // the validated SI doc was applied
  });

  it("build_part returns isError + the validation detail on a bad document", async () => {
    const tools = buildAgentTools(deps());
    const res = await tools.handlers["build_part"]!({ document: { nope: true } });
    expect(res.isError).toBe(true);
    expect(res.result).toMatch(/schema|Errors/i);
  });

  it("inspect_geometry returns the empty-geometry text when nothing is built", async () => {
    const tools = buildAgentTools(deps({ probe: async () => null }));
    const res = await tools.handlers["inspect_geometry"]!({});
    expect(res.isError).toBe(false);
    expect(res.result).toMatch(/no built geometry/i);
  });

  it("inspect_geometry enumerates faces when geometry exists", async () => {
    const oneFace: MeshView = {
      vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0],
      indices: [0, 1, 2],
      faceGroups: [{ normal: [0, 0, 1], centroid: [0.5, 0.5, 0], start: 0, count: 3 }],
      edges: [],
    };
    const tools = buildAgentTools(deps({ probe: async () => oneFace }));
    const res = await tools.handlers["inspect_geometry"]!({});
    expect(res.result).toMatch(/Face 0/);
  });

  it("answer_user echoes the message", async () => {
    const tools = buildAgentTools(deps());
    const res = await tools.handlers[ANSWER_USER]!({ message: "Built a 20mm cube." });
    expect(res.result).toBe("Built a 20mm cube.");
    expect(res.isError).toBe(false);
  });

  it("plan_part validates a decomposition graph and records it (M5)", async () => {
    const onPlan = vi.fn();
    const tools = buildAgentTools(deps({ onPlan }));
    const res = await tools.handlers["plan_part"]!({
      nodes: [{ id: "body", part: "housing" }, { id: "lid", part: "lid", parent: "body" }],
      relations: [{ from: "lid", to: "body", kind: "attached" }],
    });
    expect(res.isError).toBe(false);
    expect(res.result).toMatch(/plan accepted/i);
    // The FULL validated graph is delivered, not a summary/truncation (9-M1).
    expect(onPlan).toHaveBeenCalledOnce();
    expect(onPlan).toHaveBeenCalledWith({
      nodes: [{ id: "body", part: "housing" }, { id: "lid", part: "lid", parent: "body" }],
      relations: [{ from: "lid", to: "body", kind: "attached" }],
    });
  });

  it("plan_part returns isError on a malformed plan (so the model fixes it)", async () => {
    const tools = buildAgentTools(deps());
    const res = await tools.handlers["plan_part"]!({ nodes: [{ id: "a", part: "a", parent: "ghost" }] });
    expect(res.isError).toBe(true);
    expect(res.result).toMatch(/rejected/i);
  });

  it("create_mesh is wired only when its deps are supplied", async () => {
    const without = buildAgentTools(deps());
    expect(without.handlers["create_mesh"]).toBeUndefined();
    expect(without.defs.some((d) => d.name === "create_mesh")).toBe(false);

    const withCreative = buildAgentTools(
      deps({
        createMesh: {
          confirm: async () => false,
          resolveMeshProvider: () => undefined,
          fetchGlb: async () => new ArrayBuffer(0),
          validateGlb: async () => {},
          persist: async () => "id",
          recordPaidJob: () => {},
        },
      }),
    );
    expect(withCreative.handlers["create_mesh"]).toBeDefined();
    expect(withCreative.defs.some((d) => d.name === "create_mesh")).toBe(true);
    // A declined/invalid job surfaces as a tool result, not a throw.
    const res = await withCreative.handlers["create_mesh"]!({ mode: "text3d", prompt: "x", providerId: "nope" });
    expect(res.isError).toBe(true);
  });

  it("reconstruct_brep + fit_nurbs are wired + offered only when meshToCad deps are supplied", async () => {
    const without = buildAgentTools(deps());
    expect(without.handlers["reconstruct_brep"]).toBeUndefined();
    expect(without.handlers["fit_nurbs"]).toBeUndefined();
    expect(without.defs.some((d) => d.name === "reconstruct_brep")).toBe(false);

    const withMeshToCad = buildAgentTools(
      deps({
        meshToCad: {
          mesh: () => null, // no mesh open → the handler returns a structured error, not a throw
          reconstruct: async () => ({ step: "", report: { triangles_in: 0, triangles_used: 0, faces_built: 0, planar_faces: 0, is_solid: false, is_valid: false, method: "auto" } }),
          fitNurbs: async () => { throw new Error("unused"); },
          stepToDoc: (step, name) => ({ features: [{ id: "f1", type: "importStep", name: name ?? "x", data: { step } }], params: {} }),
          load: () => {},
        },
      }),
    );
    expect(withMeshToCad.handlers["reconstruct_brep"]).toBeDefined();
    expect(withMeshToCad.handlers["fit_nurbs"]).toBeDefined();
    expect(withMeshToCad.defs.some((d) => d.name === "reconstruct_brep")).toBe(true);
    expect(withMeshToCad.defs.some((d) => d.name === "fit_nurbs")).toBe(true);
    // No mesh open ⇒ a structured error result, not a throw.
    const res = await withMeshToCad.handlers["reconstruct_brep"]!({});
    expect(res.isError).toBe(true);
    expect(res.result).toMatch(/No mesh document is open/);
  });
});

/** A ChatProvider that yields a scripted StreamEvent[] per stream() call (drives the loop). */
class ScriptedProvider implements ChatProvider {
  readonly id = "openai-compatible" as const;
  readonly model = "fake";
  readonly supportsVision = false;
  readonly supportsTools = true;
  private i = 0;
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    const script = this.scripts[Math.min(this.i, this.scripts.length - 1)] ?? [];
    this.i += 1;
    for (const ev of script) yield ev;
  }
}
const call = (id: string, name: string, args: unknown): StreamEvent => ({ type: "tool-call", call: { id, name, arguments: args } });
const done = (): StreamEvent => ({ type: "done", finishReason: "tool-calls" });

describe("plan-conditioned execution (M5.3)", () => {
  it("the agent plans first, then builds referencing the plan, then answers", async () => {
    const apply = vi.fn();
    const onPlan = vi.fn();
    const tools: AgentTools = buildAgentTools(
      deps({ buildPart: { probe: async () => ({ ok: true }), apply }, onPlan }),
    );
    const provider = new ScriptedProvider([
      [call("p1", "plan_part", { nodes: [{ id: "box", part: "the body" }, { id: "hole", part: "a hole", parent: "box" }] }), done()],
      [call("b1", "build_part", { document: cubeDoc }), done()],
      [call("a1", ANSWER_USER, { message: "built per plan" }), done()],
    ]);
    const res = await runAgent({ provider, system: "s", messages: [{ role: "user", content: "make a box with a hole" }], tools });
    expect(onPlan).toHaveBeenCalledOnce(); // the agent committed a validated plan first
    expect(apply).toHaveBeenCalledOnce(); // then built the part
    expect(res.finish).toBe("answer");
  });

  it("a plan too big for the 200-char trace line reaches onPlan intact through runAgent (9-M1)", async () => {
    // Long enough that the panel's generic tool-call line (args JSON sliced to 200
    // chars) would cut it mid-graph — the onPlan seam must deliver it whole.
    const bigPlan = {
      nodes: [
        { id: "chassis", part: "the main quadcopter chassis plate" },
        { id: "arm-fl", part: "front-left motor arm", parent: "chassis" },
        { id: "arm-fr", part: "front-right motor arm", parent: "chassis" },
        { id: "arm-rl", part: "rear-left motor arm", parent: "chassis" },
        { id: "arm-rr", part: "rear-right motor arm", parent: "chassis" },
        { id: "canopy", part: "aerodynamic canopy shell over the electronics bay", parent: "chassis" },
      ],
      relations: [
        { from: "arm-fl", to: "chassis", kind: "attached" },
        { from: "arm-fr", to: "chassis", kind: "attached" },
        { from: "arm-rl", to: "chassis", kind: "attached" },
        { from: "arm-rr", to: "chassis", kind: "attached" },
        { from: "canopy", to: "chassis", kind: "aligned" },
        { from: "arm-fl", to: "arm-rr", kind: "symmetric" },
      ],
    };
    expect(JSON.stringify(bigPlan).length).toBeGreaterThan(200);

    const onPlan = vi.fn();
    const tools: AgentTools = buildAgentTools(deps({ onPlan }));
    const provider = new ScriptedProvider([
      [call("p1", "plan_part", bigPlan), done()],
      [call("a1", ANSWER_USER, { message: "planned" }), done()],
    ]);
    const res = await runAgent({ provider, system: "s", messages: [{ role: "user", content: "plan a quadcopter" }], tools });
    expect(res.finish).toBe("answer");
    expect(onPlan).toHaveBeenCalledOnce();
    expect(onPlan).toHaveBeenCalledWith(bigPlan); // full graph, untruncated
  });
});
