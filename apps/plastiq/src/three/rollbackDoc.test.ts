// R2 / P1 — export · lower · simulate must honour the rollback point (WYSIWYG).
//
// Before R2 the viewport rendered `buildFeatures()` (sliced at rollbackIndex)
// while export/lower/simulate read the FULL document, so a rolled-back export
// silently carried hidden features. These tests pin the pure slicing logic every
// one of those three seams now shares.

import { describe, expect, it } from "vitest";

import { buildFeatures, geometrySignature, rolledBackDocument } from "./rollbackDoc.js";
import { PLACEMENT_TYPE, type CadDocument, type EditorFeature } from "../store/types.js";

function feat(id: string, type: string): EditorFeature {
  return { id, type, params: {} } as EditorFeature;
}

/** A fake store slice with the four features the tests slice through. */
function fakeState(rollbackIndex: number | null) {
  const features: EditorFeature[] = [
    feat("f1", "box"),
    feat("f2", "extrude"),
    feat("f3", "fillet"),
    feat("f4", PLACEMENT_TYPE),
  ];
  const params = { L: 10 };
  const assembly = { instances: [], mates: [], joints: [] };
  // Stable reference, like the store's own toDocument snapshot within one call —
  // lets the "no extra clone" assertion below check reference identity.
  const doc: CadDocument = { features, params, assembly };
  return {
    features,
    params,
    rollbackIndex,
    toDocument(): CadDocument {
      return doc;
    },
  };
}

describe("R2 — rolledBackDocument ties export/lower/simulate to the rendered slice", () => {
  it("returns the FULL document unchanged (identity) when no rollback is active", () => {
    const s = fakeState(null);
    const doc = rolledBackDocument(s);
    expect(doc).toBe(s.toDocument()); // same reference — allocation-free common path
    expect(doc.features).toHaveLength(4);
  });

  it("SLICES features to the rollback point, matching what the viewport builds", () => {
    const s = fakeState(2); // roll back to after f2 (f3/fillet + f4/placement hidden)
    const doc = rolledBackDocument(s);
    expect(doc.features.map((f) => f.id)).toEqual(["f1", "f2"]);
    // The exported/simulated features are EXACTLY the rendered ones.
    expect(doc.features).toEqual(buildFeatures(s));
    // params / assembly survive the slice untouched.
    expect(doc.params).toEqual({ L: 10 });
    expect(doc.assembly).toEqual({ instances: [], mates: [], joints: [] });
  });

  it("a rollback of 0 exports an empty part (nothing is shown, nothing is exported)", () => {
    const s = fakeState(0);
    expect(rolledBackDocument(s).features).toEqual([]);
  });

  it("geometrySignature excludes placement and tracks rollback plus global-parameter edits", () => {
    const full = geometrySignature(fakeState(null));
    const rolled = geometrySignature(fakeState(2));
    expect(full).not.toEqual(rolled); // a rollback move IS a geometry change…
    // …but a pure placement feature never appears in either signature.
    expect(full).not.toContain(PLACEMENT_TYPE);
    expect(rolled).not.toContain(PLACEMENT_TYPE);

    const changedParam = fakeState(null);
    changedParam.params.L = 20;
    expect(geometrySignature(changedParam)).not.toEqual(full);
  });
});
