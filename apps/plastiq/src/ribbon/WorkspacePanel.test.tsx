// @vitest-environment jsdom
// WorkspacePanel — component test (jsdom + RTL). Smoke: the sidebar tool panel
// assembles the active workspace's flattened ribbon groups (real config + registry
// + ActionButtons) against the real store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { WorkspacePanel } from "./WorkspacePanel.js";
import { useCadStore } from "../store/store.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { defaultVoxelDoc } from "../voxel/doc.js";

beforeEach(() => useCadStore.setState({ workspace: "design" }));
afterEach(() => {
  cleanup();
  useCadStore.setState({ workspace: "design" });
  useVoxelStore.getState().close();
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

describe("WorkspacePanel — Sculpt workspace (ADR-0010)", () => {
  it("with no sculpt open, shows the prompt and only New Sculpt is enabled", () => {
    useCadStore.setState({ workspace: "sculpt" });
    render(<WorkspacePanel />);
    expect(screen.getByTestId("sculpt-status").textContent).toContain("No sculpt open");
    expect((screen.getByTestId("act-voxel-new") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("act-voxel-add") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("act-voxel-convert-cad") as HTMLButtonElement).disabled).toBe(true);
  });

  it("with a sculpt open, shows the live indicator and the tool set is enabled", () => {
    useVoxelStore.getState().open(defaultVoxelDoc("My Bust"));
    useCadStore.setState({ workspace: "sculpt" });
    render(<WorkspacePanel />);
    const status = screen.getByTestId("sculpt-status").textContent!;
    expect(status).toContain("My Bust");
    expect(status).toContain("128 voxels"); // the seeded 8×8×2 slab
    expect(status).toContain("32×32×32 @ 2.0 mm");
    expect(status).toContain("tool: add");
    expect((screen.getByTestId("act-voxel-add") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("act-voxel-erase") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("act-voxel-convert-cad") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("act-voxel-export-glb") as HTMLButtonElement).disabled).toBe(false);
  });
});
