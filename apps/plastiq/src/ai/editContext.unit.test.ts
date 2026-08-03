// SPEC-6 R2.2 (T2.2): the edit-mode context handed to the model is the current
// document as a mm/deg authoring doc, so the model edits + re-emits the whole doc.

import { describe, it, expect, beforeEach } from "vitest";
import { editContext, type EditSelectionContext } from "./editContext.js";
import { toAuthoringDoc } from "./tools/schema.js";
import { useCadStore } from "../store/store.js";
import type { CadDocument } from "../store/types.js";

const siBox = (): CadDocument => ({
  features: [{ id: "f1", type: "box", name: "Base", params: { dx: 0.04, dy: 0.02, dz: 0.01 } }],
  params: {},
});

/** An empty selection slice — nothing picked, no standing errors. */
const noSelection: EditSelectionContext = {
  picks: [],
  selectionRefs: { faces: {}, edges: {} },
  selectedFeatureId: null,
  featureErrors: {},
  featureWarnings: {},
};

// The default `selection` arg reads the live store; keep it clean between cases so the
// pre-R11 tests below (which use the default path) see no selection/error blocks.
beforeEach(() => {
  useCadStore.getState().reset();
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

  it("digests an imported STEP instead of dumping its text (no prompt blow-up)", () => {
    // A realistic-but-huge imported body: a 600 KB STEP-like blob with many faces.
    const bigStep =
      "ISO-10303-21;\nHEADER;\n" +
      "#1=ADVANCED_FACE();\n".repeat(20000) +
      "#2=MANIFOLD_SOLID_BREP();\nENDSEC;\n";
    const doc: CadDocument = {
      features: [{ id: "imp", type: "importStep", data: { step: bigStep } }],
      params: {},
    };
    const ctx = editContext(doc)!;
    // The raw STEP must NOT be in the prompt...
    expect(ctx).not.toContain("ISO-10303");
    expect(ctx.length).toBeLessThan(2000);
    // ...but a digest of the imported body must be (face count + a note).
    expect(ctx).toContain("importedSolid");
    expect(ctx).toContain("\"faces\": 20000");
    expect(ctx).toContain("edit by adding features");
  });
});

describe("R11 edit context — selection + standing errors (§5.3)", () => {
  it("renders the current selection digest (picked face + edge, in mm)", () => {
    const sel: EditSelectionContext = {
      picks: [
        { kind: "face", id: 3 },
        { kind: "edge", id: 7 },
        { kind: "vertex", id: 2 },
        { kind: "body", id: 0 },
      ],
      selectionRefs: {
        faces: {
          3: {
            normal: [0, 0, 1],
            centroid: [0.03, 0.02, 0.01], // SI m -> 30, 20, 10 mm
            surface: { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0.01] },
          },
        },
        edges: {
          7: {
            faceNormals: [
              [0, 0, 1],
              [1, 0, 0],
            ],
            midpoint: [0.03, 0, 0.005],
            faceSurfaces: [
              { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0.01] },
              { kind: "cylinder", axis: [0, 0, 1], axisPoint: [0.03, 0.02, 0], radius: 0.004 },
            ],
          },
        },
      },
      selectedFeatureId: "f1",
      featureErrors: {},
      featureWarnings: {},
    };
    const ctx = editContext(siBox(), sel)!;
    expect(ctx).toContain("CURRENT SELECTION");
    // A picked planar face, described by its surface + centroid in mm.
    expect(ctx).toContain("face #3");
    expect(ctx).toContain("planar");
    expect(ctx).toContain("at [30, 20, 10] mm");
    // A picked edge, described by its two adjacent surface kinds + midpoint in mm.
    expect(ctx).toContain("edge #7");
    expect(ctx).toContain("between planar and cylindrical faces");
    // Vertex / body picks (no stored ref) still surface so the model knows they're picked.
    expect(ctx).toContain("vertex #2");
    expect(ctx).toContain("body #0 (whole solid)");
    // The feature-tree selection is reported too.
    expect(ctx).toContain('feature "f1"');
  });

  it("falls back to the raw FaceRef normal when a face has no analytic surface", () => {
    const sel: EditSelectionContext = {
      ...noSelection,
      picks: [{ kind: "face", id: 5 }],
      selectionRefs: { faces: { 5: { normal: [0, 1, 0] } }, edges: {} },
    };
    const ctx = editContext(siBox(), sel)!;
    expect(ctx).toContain("face #5");
    expect(ctx).toContain("normal [0, 1, 0]");
  });

  it("reports standing featureErrors and featureWarnings", () => {
    const sel: EditSelectionContext = {
      ...noSelection,
      featureErrors: { f2: "extrude failed: no preceding sketch" },
      featureWarnings: { f3: "join changed nothing visible" },
    };
    const ctx = editContext(siBox(), sel)!;
    expect(ctx).toContain("BUILD ERRORS");
    expect(ctx).toContain("f2: extrude failed: no preceding sketch");
    expect(ctx).toContain("BUILD WARNINGS");
    expect(ctx).toContain("f3: join changed nothing visible");
  });

  it("collapses a multi-line error message to one terse line", () => {
    const sel: EditSelectionContext = {
      ...noSelection,
      featureErrors: { f4: "line one\n  line two\n\tline three" },
    };
    const ctx = editContext(siBox(), sel)!;
    expect(ctx).toContain("f4: line one line two line three");
  });

  it("omits both blocks when nothing is selected and the build is clean", () => {
    const ctx = editContext(siBox(), noSelection)!;
    expect(ctx).not.toContain("CURRENT SELECTION");
    expect(ctx).not.toContain("BUILD ERRORS");
    expect(ctx).not.toContain("BUILD WARNINGS");
    // The core edit block is still present.
    expect(ctx).toContain("build_part");
  });

  it("reads the LIVE store by default (the production path: no explicit selection arg)", () => {
    // runGeneration calls editContext(currentDoc) with no second arg; the default must
    // pull picks + errors from useCadStore.getState() — the same authority agentTurn
    // reads currentDoc from.
    useCadStore.setState({
      picks: [{ kind: "face", id: 0 }],
      selectionRefs: {
        faces: { 0: { normal: [0, 0, 1], surface: { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0] } } },
        edges: {},
      },
      featureErrors: { f9: "kernel: BRepAlgoAPI_Fuse produced no result" },
      featureWarnings: {},
    });
    const ctx = editContext(siBox())!; // no explicit selection -> selectionFromStore()
    expect(ctx).toContain("CURRENT SELECTION");
    expect(ctx).toContain("face #0");
    expect(ctx).toContain("BUILD ERRORS");
    expect(ctx).toContain("f9: kernel: BRepAlgoAPI_Fuse produced no result");
  });
});
