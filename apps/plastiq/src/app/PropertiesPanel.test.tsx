// @vitest-environment jsdom
// PropertiesPanel — component test (jsdom + RTL, real store). Smoke: with a feature
// selected it renders the feature editor for that feature's params.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { PropertiesPanel } from "./PropertiesPanel.js";
import { useCadStore } from "../store/store.js";
import { defaultDocument } from "../store/seed.js";

beforeEach(() => {
  useCadStore.getState().loadDocument(defaultDocument());
  useCadStore.setState({ selectedFeatureId: "f1" });
});
afterEach(cleanup);

describe("PropertiesPanel", () => {
  it("smoke: renders the feature editor for the selected feature", () => {
    render(<PropertiesPanel />);
    expect(screen.getByTestId("feature-editor")).toBeTruthy();
  });
});
