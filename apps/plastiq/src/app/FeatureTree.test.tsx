// @vitest-environment jsdom
// FeatureTree — component test (jsdom + RTL, real store). Smoke: renders the tree of
// the loaded document's features. Integration: clicking a feature row selects it in
// the store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FeatureTree } from "./FeatureTree.js";
import { useCadStore } from "../store/store.js";
import { defaultDocument } from "../store/seed.js";

beforeEach(() => useCadStore.getState().loadDocument(defaultDocument()));
afterEach(cleanup);

describe("FeatureTree", () => {
  it("smoke: renders the feature tree with a row per feature", () => {
    render(<FeatureTree />);
    expect(screen.getByTestId("feature-tree")).toBeTruthy();
    expect(screen.getAllByTestId("feature-row").length).toBe(1); // the seed's one box
  });

  it("integration: clicking a feature row selects it in the store", () => {
    useCadStore.setState({ selectedFeatureId: null });
    render(<FeatureTree />);
    fireEvent.click(screen.getAllByTestId("feature-row")[0]!);
    expect(useCadStore.getState().selectedFeatureId).toBe("f1");
  });
});

// --- Round primitives render through the REAL React path (§4.11) -------------
//
// The evaluator tests prove a cylinder BUILDS; they say nothing about whether it
// is reachable. A new feature type is exactly where a per-type icon/label lookup
// renders blank or throws — which would leave the feature unreachable while the
// geometry tests stayed green (§2.9's addMatePick shape of defect).

describe("round primitive features in the tree", () => {
  it("renders a row with the type's own icon for cylinder/sphere/cone/torus", () => {
    useCadStore.getState().loadDocument({
      features: [
        { id: "f1", type: "cylinder", name: "Cylinder1", params: { radius: 0.01, height: 0.03 } },
        { id: "f2", type: "sphere", name: "Sphere1", params: { radius: 0.015 } },
        { id: "f3", type: "cone", name: "Cone1", params: { radius1: 0.015, radius2: 0, height: 0.03 } },
        { id: "f4", type: "torus", name: "Torus1", params: { majorRadius: 0.02, minorRadius: 0.006 } },
      ],
      params: {},
    });
    render(<FeatureTree />);
    expect(screen.getAllByTestId("feature-row").length).toBe(4);
    // Each shows its OWN glyph, not the "•" unknown-type fallback.
    const text = screen.getByTestId("feature-tree").textContent ?? "";
    for (const glyph of ["⬭", "●", "▲", "◎"]) {
      expect(text, `missing icon ${glyph}`).toContain(glyph);
    }
    expect(text).toContain("Cylinder1");
  });
});
