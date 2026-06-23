// SPEC-6 R2.4 (T2.4): the parametric prompt must teach the full, current tool surface
// — every feature type, mm/deg units, edit-from-context, dress-up selection, and the
// answer_user finalizer. Sourcing the feature list from FEATURE_TYPES keeps this honest.

import { describe, it, expect } from "vitest";
import { parametricSystemPrompt, creativeSystemPrompt } from "./prompt.js";
import { FEATURE_TYPES } from "../store/featureUnits.js";

describe("R2.4 parametric system prompt", () => {
  const p = parametricSystemPrompt();

  it("enumerates every authorable feature type", () => {
    for (const t of FEATURE_TYPES) {
      if (t === "placement") continue; // a scene pose, not authored
      expect(p).toContain(t);
    }
  });

  it("states mm/deg units", () => {
    expect(p).toMatch(/millimet/i);
    expect(p).toMatch(/degree/i);
  });

  it("names build_part, inspect_geometry and answer_user", () => {
    expect(p).toContain("build_part");
    expect(p).toContain("inspect_geometry");
    expect(p).toContain("answer_user");
  });

  it("instructs edit-from-context (re-emit the whole document)", () => {
    expect(p).toMatch(/edit/i);
    expect(p).toContain("WHOLE updated document");
  });

  it("instructs dress-up selection via selector or inspect_geometry", () => {
    expect(p).toMatch(/selector/i);
    expect(p).toMatch(/fillet/i);
  });

  it("teaches that a sketch must precede extrude/cut (the common build failure)", () => {
    // A cut/extrude with no upstream sketch is the #1 generation error; the prompt
    // must state the ordering rule explicitly so the model sequences sketch->cut.
    expect(p).toMatch(/sketch/i);
    expect(p).toMatch(/preceding "sketch"|before each of them|before the/i);
    expect(p).toContain("data.profile");
  });

  it("teaches the box coordinate frame so centred features land in the centre", () => {
    // The model placed a 'centred' hole at [0,0] (a corner) because it assumed a
    // centred box; the prompt must state min-corner-at-origin + the centre formula.
    expect(p).toMatch(/minimum corner at the origin/i);
    expect(p).toContain("[dx/2, dy/2]");
  });
});

describe("R2.4 creative system prompt", () => {
  it("steers create_mesh and recommends parametric for precise parts", () => {
    const c = creativeSystemPrompt();
    expect(c).toContain("create_mesh");
    expect(c).toMatch(/parametric/i);
  });
});
