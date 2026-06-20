// SPEC-6 R2.4 — the tool surface (§7.1) defs + AgentTools dispatch wiring.

import { describe, expect, it, vi } from "vitest";
import { ANSWER_USER, buildAgentTools, toolDefs, type AgentToolDeps } from "./toolDefs.js";
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
  it("offers build_part, inspect_geometry, and answer_user by default (no create_mesh)", () => {
    const names = toolDefs({ creative: false }).map((d) => d.name);
    expect(names).toEqual(["build_part", "inspect_geometry", ANSWER_USER]);
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
});
