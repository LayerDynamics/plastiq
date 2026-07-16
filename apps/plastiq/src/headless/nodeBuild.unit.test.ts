// CB6.2 — grammar-safe tool schemas for local grammar-constrained backends.
//
// llama.cpp builds a GBNF grammar from each tool's JSON schema and 400s on the
// $ref/$defs zod emits for the recursive feature union. grammarSafeToolDefs inlines
// them WITHOUT losing the concrete field shapes (so the model still sees
// box.params.dx/dy/dz and doesn't invent length/width/height). The
// grammarSafeToolDefs tests are pure (no OCCT); the 9-M1 session-report tests below
// init the real kernel via createHeadlessSession, like generate.test.ts.

import { describe, expect, it } from "vitest";
import { createHeadlessSession, grammarSafeToolDefs } from "./nodeBuild.js";
import { toolDefs } from "../ai/tools/toolDefs.js";
import type { PlanGraph } from "../ai/planning.js";
import type { ToolDef } from "../ai/providers/types.js";

describe("grammarSafeToolDefs", () => {
  it("dereferences build_part's $ref/$defs while preserving box params (dx/dy/dz)", () => {
    const defs = toolDefs({ creative: false });
    const before = JSON.stringify(defs.find((d) => d.name === "build_part")!.parameters);
    // sanity: the raw zod schema really does use the refs we're removing
    expect(before).toContain("$ref");

    const safe = grammarSafeToolDefs(defs);
    const json = JSON.stringify(safe.find((d) => d.name === "build_part")!.parameters);
    expect(json).not.toContain("$ref");
    expect(json).not.toContain("$defs");
    expect(json).not.toContain("$schema");
    // the concrete box param names survive the inline — this is the guidance the
    // model needs (without it, it emits length/width/height and fails validation).
    expect(json).toContain("dx");
    expect(json).toContain("dy");
    expect(json).toContain("dz");
  });

  it("leaves a ref-free tool (answer_user) untouched, by reference", () => {
    const defs = toolDefs({ creative: false });
    const safe = grammarSafeToolDefs(defs);
    const au = safe.find((d) => d.name === "answer_user")!;
    const orig = defs.find((d) => d.name === "answer_user")!;
    expect(au).toBe(orig);
  });

  it("THROWS on an unresolvable $ref instead of silently degrading (no fallbacks)", () => {
    const broken: ToolDef = {
      name: "x", description: "",
      parameters: { type: "object", properties: { a: { $ref: "#/$defs/missing" } } },
    };
    expect(() => grammarSafeToolDefs([broken])).toThrow(/unresolved \$ref/i);
  });

  it("represents a genuine recursion cycle as a generic object (not a throw)", () => {
    const recursive: ToolDef = {
      name: "x", description: "",
      parameters: {
        type: "object",
        $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
        properties: { root: { $ref: "#/$defs/node" } },
      },
    };
    const out = grammarSafeToolDefs([recursive])[0]!;
    const json = JSON.stringify(out.parameters);
    expect(json).not.toContain("$ref"); // inlined
    expect(json).toContain('"child":{"type":"object"}'); // recursion point -> generic object
  });
});

describe("createHeadlessSession — a committed plan lands in the session report (9-M1)", () => {
  const plan: PlanGraph = {
    nodes: [
      { id: "body", part: "the pump housing" },
      { id: "lid", part: "the inspection lid", parent: "body" },
    ],
    relations: [{ from: "lid", to: "body", kind: "attached" }],
  };

  it("plan_part's validated graph is reported via session.plan(), full and intact", async () => {
    const session = await createHeadlessSession();
    expect(session.plan()).toBeNull(); // never planned yet
    const res = await session.tools.handlers["plan_part"]!(plan);
    expect(res.isError).toBe(false);
    expect(session.plan()).toEqual(plan); // the headless twin of the trace entry
  });

  it("a rejected plan is NOT reported (the error goes back to the model instead)", async () => {
    const session = await createHeadlessSession();
    const res = await session.tools.handlers["plan_part"]!({
      nodes: [{ id: "a", part: "a", parent: "ghost" }],
    });
    expect(res.isError).toBe(true);
    expect(session.plan()).toBeNull();
  });
});
