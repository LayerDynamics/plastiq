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

  it("teaches the build vocabulary that fixes the common geometry mistakes", () => {
    // Each phrase guards a real failure observed in generation:
    expect(p).toMatch(/silently ignored/i);   // a feature OBJECT under a non-"features" key vanishes
    expect(p).toMatch(/round.*sketch|cylinder/i); // a cylinder is sketch-circle+extrude, not a box
    expect(p).toContain("boolean");           // REMOVE / multi-body tools, not boss pads
    expect(p).toMatch(/\bsubtract\b/i);
    expect(p).toContain("convexEdges");        // fillet EVERY edge via the whole-part selector
    expect(p).toContain("data.edges or data.faces"); // dress-ups: selector only, no explicit edges
    expect(p).toMatch(/"to":\s*\[60,0\]/);     // a worked closed-loop (L-profile) example
  });

  it("teaches join-by-default for extrude/revolve (matches rebuild; C11)", () => {
    expect(p).toMatch(/JOIN BY DEFAULT/i);
    expect(p).toMatch(/JOIN \(fuse\)|join \(fuse\)|JOIN onto/i);
    // Must NOT teach replace-body as the default for pads/revolves.
    expect(p).not.toMatch(/REPLACE the current body/i);
    expect(p).toMatch(/data\.op is "new"|data\.op "new"/i);
    expect(p).toMatch(/toFace/i);
  });

  it("R11: documents assembly/placement TRUTHFULLY (both are schema-accepted)", () => {
    // The schema accepts an "assembly" top-level key (schema.ts documentSchema) and a
    // "placement" feature (schema.ts) — the prompt must NOT deny them.
    expect(p).not.toMatch(/Do NOT invent other keys such as "assembly"/);
    // It documents "assembly" as an accepted key, not a vanishing one...
    expect(p).toMatch(/optional "assembly"|"assembly" \(component/i);
    // ...and tells the model to PRESERVE an existing assembly/placement on re-emit.
    expect(p).toMatch(/placement/i);
    expect(p).toMatch(/PRESERVE/i);
  });

  it("R11: is selection-aware (honor 'the face I picked')", () => {
    expect(p).toMatch(/CURRENT SELECTION/);
    expect(p).toMatch(/the face I\s+picked|face I picked/i);
    // The seed-a-selector-from-the-pick guidance (not raw pick ids).
    expect(p).toMatch(/tangentFaces/);
  });
});

describe("R2.4 creative system prompt", () => {
  it("steers create_mesh and recommends parametric for precise parts", () => {
    const c = creativeSystemPrompt();
    expect(c).toContain("create_mesh");
    expect(c).toMatch(/parametric/i);
  });
});
