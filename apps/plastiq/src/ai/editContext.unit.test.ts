// SPEC-6 R2.2 (T2.2): the edit-mode context handed to the model is the current
// document as a mm/deg authoring doc, so the model edits + re-emits the whole doc.

import { describe, it, expect } from "vitest";
import { editContext } from "./editContext.js";
import { toAuthoringDoc } from "./tools/schema.js";
import type { CadDocument } from "../store/types.js";

const siBox = (): CadDocument => ({
  features: [{ id: "f1", type: "box", name: "Base", params: { dx: 0.04, dy: 0.02, dz: 0.01 } }],
  params: {},
});

describe("R2.2 edit context", () => {
  it("is null when there is no open part", () => {
    expect(editContext(null)).toBeNull();
    expect(editContext(undefined)).toBeNull();
    expect(editContext({ features: [], params: {} })).toBeNull();
  });

  it("embeds the current document in mm/deg authoring units", () => {
    const ctx = editContext(siBox())!;
    expect(ctx).toContain("build_part");
    // SI 0.04 m must appear to the model as 40 mm.
    expect(ctx).toContain("40");
    expect(ctx).not.toContain("0.04");
  });

  it("embeds JSON that parses back to the authoring form of the current doc", () => {
    const doc = siBox();
    const ctx = editContext(doc)!;
    const json = ctx.slice(ctx.indexOf("{"), ctx.lastIndexOf("}") + 1);
    expect(JSON.parse(json)).toEqual(toAuthoringDoc(doc));
  });
});
