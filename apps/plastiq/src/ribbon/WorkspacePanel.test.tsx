// @vitest-environment jsdom
// WorkspacePanel — component test (jsdom + RTL). Smoke: the sidebar tool panel
// assembles the active workspace's flattened ribbon groups (real config + registry
// + ActionButtons) against the real store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { WorkspacePanel } from "./WorkspacePanel.js";
import { useCadStore } from "../store/store.js";

beforeEach(() => useCadStore.setState({ workspace: "design" }));
afterEach(() => {
  cleanup();
  useCadStore.setState({ workspace: "design" });
});

describe("WorkspacePanel — smoke", () => {
  it("renders the workspace tool panel", () => {
    render(<WorkspacePanel />);
    expect(screen.getByTestId("workspace-panel")).toBeTruthy();
  });

  it("renders tool buttons from the flattened ribbon groups", () => {
    render(<WorkspacePanel />);
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});
