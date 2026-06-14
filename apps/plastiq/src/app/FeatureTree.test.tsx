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
