// CB6.2 — grammar-safe tool schemas for local grammar-constrained backends.
//
// llama.cpp builds a GBNF grammar from each tool's JSON schema and 400s on the
// $ref/$defs zod emits for the recursive feature union. grammarSafeToolDefs inlines
// them WITHOUT losing the concrete field shapes (so the model still sees
// box.params.dx/dy/dz and doesn't invent length/width/height). Pure — no OCCT.

import { describe, expect, it } from "vitest";
import { grammarSafeToolDefs } from "./nodeBuild.js";
import { toolDefs } from "../ai/tools/toolDefs.js";

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
});
